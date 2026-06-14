#!/usr/bin/env python3
"""
agregar_loteos.py
=================
Cruza cicatrices GEE con loteos municipales IDECOR para detectar
"se quemó → se loteó". Modifica data/incendios_{año}.geojson in-place.

Requiere haber corrido descargar_loteos.py primero.

Uso:
  python agregar_loteos.py
  python agregar_loteos.py --years 2019 2020 2021
"""

import argparse, json, re, sys
from pathlib import Path
from shapely.geometry import shape

DATA_DIR = Path("data")
YEARS    = range(2018, 2026)

LOT_FILES = [
    DATA_DIR / "loteos_aprobados.geojson",
    DATA_DIR / "loteos_autorizados.geojson",
]


def extract_year(s):
    if not s:
        return None
    m = re.search(r'\d{2}/\d{2}/(\d{2,4})', s)
    if m:
        y = int(m.group(1))
        return 2000 + y if y < 100 else y
    m = re.search(r'\b(19|20)\d{2}\b', s)
    if m:
        return int(m.group(0))
    return None


def load_loteos():
    shapes = []
    for path in LOT_FILES:
        if not path.exists():
            print(f"  No existe {path} — correr descargar_loteos.py primero")
            continue
        with open(path, encoding="utf-8") as f:
            fc = json.load(f)
        for feat in fc["features"]:
            try:
                geom = shape(feat["geometry"])
                if not geom.is_valid:
                    geom = geom.buffer(0)
                props = feat.get("properties") or {}
                year = extract_year(str(props.get("decresapro") or ""))
                if not year:
                    year = extract_year(str(props.get("autorizado") or ""))
                shapes.append({
                    "geom":    geom,
                    "nombre":  props.get("nombre") or props.get("nombfant") or "",
                    "titular": props.get("titular") or "",
                    "tipo":    props.get("tipoloteo") or "",
                    "year":    year,
                })
            except Exception as e:
                print(f"  Loteo inválido: {e}", file=sys.stderr)
    return shapes


def enrich_year(fire_year, loteo_shapes):
    src = DATA_DIR / f"incendios_{fire_year}.geojson"
    if not src.exists():
        print(f"  No existe {src}, saltando")
        return

    with open(src, encoding="utf-8") as f:
        gee = json.load(f)

    n_overlap = n_post = 0
    for feat in gee["features"]:
        try:
            scar = shape(feat["geometry"])
            if not scar.is_valid:
                scar = scar.buffer(0)
        except Exception:
            feat["properties"].update({
                "loteo_superpuesto":   False,
                "loteo_post_incendio": False,
                "nombre_loteo":        "",
                "titular_loteo":       "",
            })
            continue

        matches = []
        for lot in loteo_shapes:
            try:
                if scar.intersects(lot["geom"]):
                    matches.append(lot)
            except Exception:
                pass

        if matches:
            nombres   = ", ".join(dict.fromkeys(m["nombre"]  for m in matches if m["nombre"]))
            titulares = ", ".join(dict.fromkeys(m["titular"] for m in matches if m["titular"]))
            post      = any(m["year"] and m["year"] > fire_year for m in matches)
            n_overlap += 1
            if post:
                n_post += 1
            feat["properties"].update({
                "loteo_superpuesto":   True,
                "loteo_post_incendio": post,
                "nombre_loteo":        nombres,
                "titular_loteo":       titulares,
            })
        else:
            feat["properties"].update({
                "loteo_superpuesto":   False,
                "loteo_post_incendio": False,
                "nombre_loteo":        "",
                "titular_loteo":       "",
            })

    with open(src, "w", encoding="utf-8") as f:
        json.dump(gee, f, ensure_ascii=False, separators=(",", ":"))

    total = len(gee["features"])
    print(f"  {fire_year}: {n_overlap}/{total} con loteo · {n_post} post-incendio")


def main():
    parser = argparse.ArgumentParser(description="Agrega cruce con loteos IDECOR a cicatrices GEE")
    parser.add_argument("--years", nargs="+", type=int, default=list(YEARS))
    args = parser.parse_args()

    print("Cargando loteos...")
    loteo_shapes = load_loteos()
    if not loteo_shapes:
        print("Sin loteos. Correr descargar_loteos.py primero.")
        return
    print(f"  {len(loteo_shapes)} loteos cargados")

    for year in args.years:
        print(f"\n== {year} ==")
        enrich_year(year, loteo_shapes)

    print("\nListo.")


if __name__ == "__main__":
    main()
