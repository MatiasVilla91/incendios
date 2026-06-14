#!/usr/bin/env python3
"""
enrich_with_idecor.py
=====================
Cruza las cicatrices GEE (data/incendios_{año}.geojson) con los datos de
áreas quemadas oficiales de IDECOR (WFS) para agregar a cada polígono:

  - idecor_verificado  : bool   — IDECOR también detectó fuego aquí
  - bosque_nativo      : bool   — quemó Monte o Matorral/Arbustal nativo
  - coberturas_idecor  : str    — lista de coberturas IDECOR (sep. "; ")
  - localidad_idecor   : str    — localidad más próxima (IDECOR)
  - departamento_idecor: str    — departamento (IDECOR)

Uso:
  python enrich_with_idecor.py
  python enrich_with_idecor.py --years 2023 2024

El script modifica los archivos data/incendios_{año}.geojson in-place.
Guarda una copia en data/area_quemada_{año}.geojson como referencia.
"""

import argparse
import json
import math
import sys
import urllib.request
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import shape, mapping
from shapely.ops import transform as shp_transform

# ── Configuración ──────────────────────────────────────────────────────────────
WFS_BASE = (
    "https://idecor-ws.mapascordoba.gob.ar/geoserver/idecor/wfs"
    "?service=WFS&version=2.0.0&request=GetFeature"
    "&typeNames=idecor:area_quemada_{year}"
    "&outputFormat=application/json"
    "&count={count}&startIndex={start}"
)
PAGE_SIZE   = 500
DATA_DIR    = Path("data")
YEARS_GEE   = range(2021, 2026)   # area_quemada IDECOR solo desde 2021

# Coberturas que corresponden a bosque / vegetación nativa leñosa
BOSQUE_KEYWORDS = ("monte", "matorral", "arbustal", "vegetacion le")

# EPSG:22174  →  WGS84 (lon/lat)
_transformer = Transformer.from_crs("EPSG:22174", "EPSG:4326", always_xy=True)


def reproject_coords(coords):
    """Transforma una lista de coordenadas [x,y] de 22174 → WGS84."""
    out = []
    for c in coords:
        if isinstance(c[0], (int, float)):
            lon, lat = _transformer.transform(c[0], c[1])
            out.append([lon, lat])
        else:
            out.append(reproject_coords(c))
    return out


def reproject_geometry(geom):
    """Transforma una geometría GeoJSON completa de EPSG:22174 → WGS84."""
    g = dict(geom)
    g["coordinates"] = reproject_coords(g["coordinates"])
    return g


def is_bosque(props):
    for k in ("cobertura1", "cobertura2", "cobertura3", "cobertura4"):
        v = props.get(k) or ""
        if any(kw in v.lower() for kw in BOSQUE_KEYWORDS):
            return True
    return False


def coberturas_str(props):
    parts = []
    for k in ("cobertura1", "cobertura2", "cobertura3", "cobertura4"):
        v = props.get(k)
        if v:
            parts.append(v.strip())
    return "; ".join(parts)


def download_idecor_year(year):
    """Descarga todos los features de area_quemada_{year}, reproyecta a WGS84."""
    features = []
    start = 0
    total = None
    while True:
        url = WFS_BASE.format(year=year, count=PAGE_SIZE, start=start)
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                data = json.load(r)
        except Exception as e:
            print(f"  ERROR descargando página start={start}: {e}", file=sys.stderr)
            break

        if total is None:
            total = data.get("totalFeatures", 0)
            print(f"  {total} features en area_quemada_{year}")

        batch = data.get("features", [])
        if not batch:
            break

        for f in batch:
            f["geometry"] = reproject_geometry(f["geometry"])
            features.append(f)

        start += len(batch)
        if start >= total:
            break

    return features


def build_idecor_shapes(features):
    """Convierte features IDECOR a lista de (shapely_geom, props)."""
    out = []
    for f in features:
        try:
            geom = shape(f["geometry"])
            if not geom.is_valid:
                geom = geom.buffer(0)
            out.append((geom, f["properties"]))
        except Exception:
            pass
    return out


def intersects_any(scar_shape, idecor_shapes):
    """Devuelve (match, bosque, coberturas_str, localidad, departamento)."""
    matches = []
    for idecor_geom, props in idecor_shapes:
        try:
            if scar_shape.intersects(idecor_geom):
                matches.append(props)
        except Exception:
            pass

    if not matches:
        return False, False, "", "", ""

    bosque      = any(is_bosque(p) for p in matches)
    coberturas  = "; ".join(
        dict.fromkeys(  # deduplica preservando orden
            c for p in matches for c in coberturas_str(p).split("; ") if c
        )
    )
    localidades  = ", ".join(dict.fromkeys(
        p.get("localidad_proxima", "") for p in matches if p.get("localidad_proxima")
    ))
    departamentos = ", ".join(dict.fromkeys(
        p.get("departamento", "") for p in matches if p.get("departamento")
    ))
    return True, bosque, coberturas, localidades, departamentos


def enrich_year(year, idecor_shapes):
    src = DATA_DIR / f"incendios_{year}.geojson"
    if not src.exists():
        print(f"  No existe {src}, saltando")
        return

    with open(src, encoding="utf-8") as f:
        gee = json.load(f)

    features = gee.get("features", [])
    n_match  = 0
    n_bosque = 0

    for feat in features:
        try:
            scar = shape(feat["geometry"])
            if not scar.is_valid:
                scar = scar.buffer(0)
        except Exception:
            feat["properties"].update({
                "idecor_verificado": False,
                "bosque_nativo": False,
                "coberturas_idecor": "",
                "localidad_idecor": "",
                "departamento_idecor": "",
            })
            continue

        match, bosque, cob, loc, dep = intersects_any(scar, idecor_shapes)
        feat["properties"].update({
            "idecor_verificado":   match,
            "bosque_nativo":       bosque,
            "coberturas_idecor":   cob,
            "localidad_idecor":    loc,
            "departamento_idecor": dep,
        })
        if match:  n_match  += 1
        if bosque: n_bosque += 1

    with open(src, "w", encoding="utf-8") as f:
        json.dump(gee, f, ensure_ascii=False, separators=(",", ":"))

    print(f"  {year}: {n_match}/{len(features)} verificados · {n_bosque} con bosque nativo")


def main():
    parser = argparse.ArgumentParser(description="Enriquece cicatrices GEE con datos IDECOR")
    parser.add_argument("--years", nargs="+", type=int,
                        default=list(YEARS_GEE), help="Años a procesar")
    args = parser.parse_args()

    DATA_DIR.mkdir(exist_ok=True)

    for year in args.years:
        print(f"\n== {year} ==================================")
        print("  Descargando area_quemada IDECOR...")
        idecor_features = download_idecor_year(year)

        if not idecor_features:
            print("  Sin datos IDECOR, saltando enriquecimiento")
            continue

        # Guardar referencia local
        ref_path = DATA_DIR / f"area_quemada_{year}.geojson"
        with open(ref_path, "w", encoding="utf-8") as f:
            json.dump({"type": "FeatureCollection", "features": idecor_features},
                      f, ensure_ascii=False, separators=(",", ":"))
        print(f"  Guardado en {ref_path}")

        print("  Construyendo índice espacial...")
        idecor_shapes = build_idecor_shapes(idecor_features)
        print(f"  {len(idecor_shapes)} geometrías válidas")

        print("  Intersectando con cicatrices GEE...")
        enrich_year(year, idecor_shapes)

    print("\nListo")


if __name__ == "__main__":
    main()
