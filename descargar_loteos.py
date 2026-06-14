#!/usr/bin/env python3
"""
descargar_loteos.py
===================
Descarga loteos municipales de IDECOR WFS y los guarda en data/.
Genera data/loteos_aprobados.geojson y data/loteos_autorizados.geojson

Uso:
  python descargar_loteos.py
"""

import json
import sys
import urllib.request
from pathlib import Path

from pyproj import Transformer

DATA_DIR = Path("data")
PAGE_SIZE = 500

WFS_BASE = (
    "https://idecor-ws.mapascordoba.gob.ar/geoserver/idecor/wfs"
    "?service=WFS&version=2.0.0&request=GetFeature"
    "&typeNames=idecor:{layer}"
    "&outputFormat=application/json"
    "&count={count}&startIndex={start}"
)

_transformer = Transformer.from_crs("EPSG:22174", "EPSG:4326", always_xy=True)

LAYERS = [
    ("loteos_muni_aprobados",   "data/loteos_aprobados.geojson"),
    ("loteos_muni_autorizados", "data/loteos_autorizados.geojson"),
]


def reproject_coords(coords):
    out = []
    for c in coords:
        if isinstance(c[0], (int, float)):
            lon, lat = _transformer.transform(c[0], c[1])
            out.append([lon, lat])
        else:
            out.append(reproject_coords(c))
    return out


def reproject_geometry(geom):
    g = dict(geom)
    g["coordinates"] = reproject_coords(g["coordinates"])
    return g


def download_layer(layer_name):
    features = []
    start = 0
    total = None
    while True:
        url = WFS_BASE.format(layer=layer_name, count=PAGE_SIZE, start=start)
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                data = json.load(r)
        except Exception as e:
            print(f"  ERROR en start={start}: {e}", file=sys.stderr)
            break

        if total is None:
            total = data.get("totalFeatures", 0)
            print(f"  {total} features en {layer_name}")

        batch = data.get("features", [])
        if not batch:
            break

        for f in batch:
            try:
                f["geometry"] = reproject_geometry(f["geometry"])
            except Exception:
                pass
            features.append(f)

        start += len(batch)
        if start >= total:
            break

    return features


def main():
    DATA_DIR.mkdir(exist_ok=True)

    for layer_name, out_path in LAYERS:
        print(f"\n== {layer_name} ==")
        features = download_layer(layer_name)

        if not features:
            print("  Sin datos.")
            continue

        # Mostrar propiedades del primer feature
        sample_props = features[0].get("properties", {})
        print(f"  Propiedades disponibles: {list(sample_props.keys())}")
        print(f"  Ejemplo: {json.dumps(sample_props, ensure_ascii=False, indent=2)[:500]}")

        fc = {"type": "FeatureCollection", "features": features}
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(fc, f, ensure_ascii=False, separators=(",", ":"))
        print(f"  Guardado en {out_path}")

    print("\nListo")


if __name__ == "__main__":
    main()
