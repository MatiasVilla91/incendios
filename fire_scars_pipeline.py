#!/usr/bin/env python3
"""
fire_scars_pipeline.py
======================
Histórico de cicatrices de incendio en Córdoba (2018–presente)
usando Google Earth Engine + Sentinel-2 SR Harmonized.

Flujo por año:
  Sentinel-2 (jul–ago)  → compuesto "antes"   ─┐
  Sentinel-2 (oct–nov)  → compuesto "después"  ─┤→ dNBR → severidad → polígonos
  Cloud Score+          → máscara de nubes    ─┘

Salida (--mode local, por defecto):
  data/incendios_{año}.geojson   ← uno por año
  incendios_historico.geojson    ← todos los años fusionados

Salida (--mode drive):
  Exporta tareas a Google Drive; descargás manualmente y copiás a data/.

Autenticación (una sola vez):
  earthengine authenticate --project TU_PROYECTO_CLOUD

Uso rápido:
  python fire_scars_pipeline.py --project TU_PROYECTO_CLOUD
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

try:
    import ee
except ImportError:
    sys.exit(
        "Falta earthengine-api.  Instalalo con:\n"
        "  pip install earthengine-api\n"
    )

# ── Parámetros ───────────────────────────────────────────────────────────────
YEAR_START = 2018
# Excluir el año actual si la temporada de fuego (jul–nov) todavía no ocurrió.
# En junio de 2026, por ejemplo, no hay imágenes "antes" (jul–ago) todavía.
_now = datetime.now()
YEAR_END = _now.year if _now.month >= 12 else _now.year - 1

# Bounding box provincia de Córdoba [oeste, sur, este, norte]
# (coincide con FIRMS_AREA en planeta.js)
CORDOBA_BBOX = [-66.0, -35.2, -61.5, -29.4]

# Ventanas temporales (mes-día).
# Invierno seco = antes de los incendios; primavera = después.
PRE_START_MD  = "07-01"
PRE_END_MD    = "08-31"
POST_START_MD = "10-01"
POST_END_MD   = "11-30"

# Cloud Score+ — umbral de claridad (0 = nube, 1 = despejado)
CLEAR_THRESHOLD = 0.60

# Escala de análisis en metros. 100 m = buen punto de partida (rápido).
# Subir a 20–50 para más detalle (mucho más lento; recomendado con --mode drive).
ANALYSIS_SCALE = 100

# Simplificación de geometrías (metros). Reduce el peso del GeoJSON.
SIMPLIFY_M = 300

# Área mínima de polígono exportado (hectáreas). Filtra ruido de píxeles sueltos.
MIN_AREA_HA = 1.0

DATA_DIR    = Path("data")
MERGED_FILE = Path("incendios_historico.geojson")

# Etiquetas de severidad según umbrales USGS / Key & Benson 2006
# dNBR sin escalar:  0.10–0.27 baja | 0.27–0.44 mod-baja | 0.44–0.66 mod-alta | >0.66 severa
SEV_LABELS = ["", "baja", "moderada_baja", "moderada_alta", "severa"]  # índice = clase (1-4)


# ── Autenticación ────────────────────────────────────────────────────────────
def init_gee(project: str | None = None) -> None:
    credentials_file = (
        Path.home() / ".config" / "earthengine" / "credentials"
    )
    if not credentials_file.exists():
        print("  Primera vez: iniciando autenticación con Google Earth Engine...")
        ee.Authenticate()

    kwargs = {"project": project} if project else {}
    try:
        ee.Initialize(**kwargs)
        print("  GEE listo.\n")
    except ee.EEException as exc:
        # Credenciales expiradas u otro problema de auth
        print(f"  Fallo al inicializar ({exc}). Re-autenticando...")
        ee.Authenticate()
        ee.Initialize(**kwargs)
        print("  GEE listo.\n")


# ── Compuesto Sentinel-2 libre de nubes ─────────────────────────────────────
def s2_composite(region: ee.Geometry, start: str, end: str) -> ee.Image:
    """Mediana de imágenes Sentinel-2 SR con máscara Cloud Score+."""
    cs_plus = ee.ImageCollection("GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED")

    col = (
        ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
        .filterBounds(region)
        .filterDate(start, end)
        .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 60))
        .linkCollection(cs_plus, ["cs_cdf"])
        .map(
            lambda img: img
            .updateMask(img.select("cs_cdf").gte(CLEAR_THRESHOLD))
            .divide(10000)   # reflectancia: 0–10 000 → 0–1
        )
    )
    return col.median().clip(region)


# ── NBR ──────────────────────────────────────────────────────────────────────
def nbr(img: ee.Image) -> ee.Image:
    """NBR = (B8 – B12) / (B8 + B12).  Rango: –1 a 1."""
    return img.normalizedDifference(["B8", "B12"]).rename("NBR")


# ── Clasificación de severidad ────────────────────────────────────────────────
def classify_severity(dnbr: ee.Image) -> ee.Image:
    """
    Asigna clase de severidad a cada píxel según umbrales USGS.
    Devuelve imagen enmascarada a clase >= 2 (quema moderada-baja o mayor).

    Clase | dNBR (sin ×1000) | Descripción
    ------+------------------+--------------
      1   |  0.10 – 0.27     | quema baja
      2   |  0.27 – 0.44     | moderada-baja  ← mínimo exportado
      3   |  0.44 – 0.66     | moderada-alta
      4   |  > 0.66          | severa
    """
    sev = (
        ee.Image(0)
        .where(dnbr.gte(0.10).And(dnbr.lt(0.27)), 1)
        .where(dnbr.gte(0.27).And(dnbr.lt(0.44)), 2)
        .where(dnbr.gte(0.44).And(dnbr.lt(0.66)), 3)
        .where(dnbr.gte(0.66), 4)
        .rename("severidad")
        .toByte()
    )
    return sev.updateMask(sev.gte(2))


# ── Pipeline por año ──────────────────────────────────────────────────────────
def build_year_fc(year: int, region: ee.Geometry) -> ee.FeatureCollection:
    """
    Construye la FeatureCollection de cicatrices para un año.
    Todo el procesamiento ocurre del lado de GEE (lazy); ningún dato
    se descarga hasta llamar a getInfo() o Export.
    """
    pre  = s2_composite(region, f"{year}-{PRE_START_MD}",  f"{year}-{PRE_END_MD}")
    post = s2_composite(region, f"{year}-{POST_START_MD}", f"{year}-{POST_END_MD}")

    dnbr = nbr(pre).subtract(nbr(post)).rename("dNBR")
    sev  = classify_severity(dnbr)

    # Suavizado morfológico: elimina píxeles aislados sin cambiar la forma principal
    sev = sev.focal_mode(radius=1, kernelType="square", iterations=2)
    sev = sev.updateMask(sev.gte(2))

    # Vectorizar zonas conectadas del mismo nivel de severidad
    vectors = sev.reduceToVectors(
        geometry=region,
        scale=ANALYSIS_SCALE,
        geometryType="polygon",
        eightConnected=False,
        maxPixels=1_000_000_000_000,
        bestEffort=True,
        labelProperty="severidad",   # guarda el valor del píxel en prop. "severidad"
    )

    # Filtrar polígonos pequeños (la prop. "count" viene de reduceToVectors)
    vectors = vectors.map(
        lambda f: f.set("_area_ha", f.area(1).divide(10_000))
    )
    vectors = vectors.filter(ee.Filter.gte("_area_ha", MIN_AREA_HA))

    # Enriquecer, simplificar y limpiar propiedades
    sev_labels_ee = ee.List(SEV_LABELS)

    def enrich(f):
        sev_val = f.get("severidad")
        label   = sev_labels_ee.get(ee.Number(sev_val).toInt())
        return (
            f.simplify(SIMPLIFY_M)
             .set("year",            year)
             .set("severidad",       sev_val)
             .set("severidad_label", label)
             .set("area_ha",         ee.Number(f.get("_area_ha")).round())
        )

    return (
        vectors
        .map(enrich)
        .select(["year", "severidad", "severidad_label", "area_ha"])
    )


# ── Exportar local con paginación ────────────────────────────────────────────
_PAGE_SIZE = 4000   # máx features por llamada a toList (GEE limita getInfo a ~5000)

def _normalize_features(raw_features: list, year: int) -> list:
    for feat in raw_features:
        p = feat.get("properties", {})
        feat["properties"] = {
            "year":             int(p.get("year", year)),
            "severidad":        int(p.get("severidad", 0)),
            "severidad_label":  str(p.get("severidad_label", "")),
            "area_ha":          float(p.get("area_ha", 0)),
        }
    return raw_features


def export_local(year: int, fc: ee.FeatureCollection, out_path: Path) -> list:
    """Descarga polígonos paginando con toList() para superar el límite de 5000 features."""
    # Paso 1: contar features del lado del servidor
    print(f"  Contando polígonos {year}...", end="", flush=True)
    try:
        total = fc.size().getInfo()
    except Exception as exc:
        print(f"\n  [!] No se pudo contar features para {year}: {exc}")
        return []

    if total == 0:
        print(" sin quemas detectadas (año limpio o sin imágenes disponibles).")
        return []

    print(f" {total} polígonos. Descargando...", flush=True)

    # Paso 2: paginar con toList(count, offset)
    all_features: list = []
    offset = 0
    while offset < total:
        end = min(offset + _PAGE_SIZE, total)
        print(f"    {offset + 1}–{end} / {total}...", end="", flush=True)
        try:
            batch = fc.toList(_PAGE_SIZE, offset).getInfo()
            all_features.extend(batch)
            print(f" OK ({len(batch)} features)")
        except Exception as exc:
            print(f"\n  [!] Error en página {offset}–{end}: {exc}")
            break
        offset += _PAGE_SIZE

    if not all_features:
        print(f"  [!] No se descargó ningún polígono para {year}.")
        return []

    all_features = _normalize_features(all_features, year)

    geojson_out = {"type": "FeatureCollection", "features": all_features}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(geojson_out, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"  OK {len(all_features)} poligonos -> {out_path}")
    return all_features


# ── Exportar a Google Drive ───────────────────────────────────────────────────
def export_drive(year: int, fc: ee.FeatureCollection, folder: str) -> None:
    """Lanza una tarea de exportación a Google Drive (asíncrona)."""
    task = ee.batch.Export.table.toDrive(
        collection=fc,
        description=f"incendios_cordoba_{year}",
        folder=folder,
        fileNamePrefix=f"incendios_{year}",
        fileFormat="GeoJSON",
        selectors=["year", "severidad", "severidad_label", "area_ha"],
    )
    task.start()
    print(f"  Tarea enviada: incendios_{year}  (id: {task.id})")


# ── Main ──────────────────────────────────────────────────────────────────────
def main() -> None:
    global ANALYSIS_SCALE, MIN_AREA_HA
    parser = argparse.ArgumentParser(
        description="Histórico de cicatrices de incendio en Córdoba vía GEE.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"""
ejemplos:
  # Generar GeoJSONs locales para todos los años (2018–{YEAR_END}):
  python fire_scars_pipeline.py --project mi-proyecto-gee

  # Solo 2020 y 2024, a escala 50 m:
  python fire_scars_pipeline.py --project mi-proyecto-gee --years 2020 2024 --scale 50

  # Exportar a Google Drive en alta resolución (para áreas grandes):
  python fire_scars_pipeline.py --project mi-proyecto-gee --mode drive --scale 20

  # Usar variable de entorno en vez de --project:
  export GEE_PROJECT=mi-proyecto-gee
  python fire_scars_pipeline.py
        """,
    )
    parser.add_argument(
        "--project", "-p",
        help="ID del proyecto Google Cloud (ej. my-project-123). "
             "Alternativa: variable de entorno GEE_PROJECT.",
        default=os.environ.get("GEE_PROJECT"),
    )
    parser.add_argument(
        "--mode", choices=["local", "drive"], default="local",
        help=(
            "local  → descarga polígonos directamente con getInfo() (inmediato, "
            "puede fallar en años con muchos incendios). "
            "drive  → exporta tareas a Google Drive (robusto, requiere descarga manual)."
        ),
    )
    parser.add_argument(
        "--drive-folder", default="incendios_cordoba",
        help="Carpeta en Google Drive (solo para --mode drive). Default: incendios_cordoba",
    )
    parser.add_argument(
        "--years", nargs="+", type=int,
        help=f"Años a procesar. Ej: --years 2020 2021 2024. Default: {YEAR_START}–{YEAR_END}.",
    )
    parser.add_argument(
        "--scale", type=int, default=ANALYSIS_SCALE,
        help=f"Escala de análisis en metros. Default: {ANALYSIS_SCALE}. "
             "Menor = más detalle + más lento.",
    )
    parser.add_argument(
        "--min-area", type=float, default=MIN_AREA_HA,
        help=f"Área mínima de polígono en hectáreas. Default: {MIN_AREA_HA}.",
    )
    args = parser.parse_args()

    ANALYSIS_SCALE = args.scale
    MIN_AREA_HA    = args.min_area

    print("Inicializando Google Earth Engine...")
    init_gee(args.project)

    years  = args.years or list(range(YEAR_START, YEAR_END + 1))
    region = ee.Geometry.Rectangle(CORDOBA_BBOX)

    all_features: list = []

    for year in years:
        print(f"-- {year} {'-' * 40}")
        try:
            fc = build_year_fc(year, region)
        except Exception as exc:
            print(f"  [!] No se pudo construir la imagen para {year}: {exc}")
            continue

        if args.mode == "local":
            feats = export_local(year, fc, DATA_DIR / f"incendios_{year}.geojson")
            all_features.extend(feats)
        else:
            export_drive(year, fc, args.drive_folder)

    # Resultado final
    print()
    if args.mode == "local":
        if all_features:
            merged = {"type": "FeatureCollection", "features": all_features}
            MERGED_FILE.write_text(
                json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            print(f"Archivo fusionado:  {MERGED_FILE}")
            print(f"Total de polígonos: {len(all_features)}")
            print(f"Archivos por año:   {DATA_DIR}/incendios_{{año}}.geojson")
        else:
            print("No se generaron polígonos. Revisá los errores de arriba.")
    else:
        print(
            "Tareas de exportación enviadas.\n"
            "Monitorealas en: https://code.earthengine.google.com/tasks\n"
            "Una vez completadas, descargá los GeoJSONs de Drive y copiálos a data/"
        )


if __name__ == "__main__":
    main()
