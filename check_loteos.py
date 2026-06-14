import json
from pathlib import Path

for year in [2019, 2020, 2024, 2025]:
    path = Path(f"data/incendios_{year}.geojson")
    if not path.exists():
        continue
    with open(path, encoding="utf-8") as f:
        fc = json.load(f)
    matches = [feat for feat in fc["features"] if feat["properties"].get("loteo_superpuesto")]
    if not matches:
        continue
    print(f"\n=== {year} ({len(matches)} coincidencias) ===")
    for feat in matches:
        p = feat["properties"]
        coords = feat["geometry"]["coordinates"]
        def first_point(c):
            if isinstance(c[0], (int, float)):
                return c
            return first_point(c[0])
        pt = first_point(coords)
        nombre = p.get("nombre_loteo", "")
        post   = p.get("loteo_post_incendio")
        area   = p.get("area_ha", "?")
        print(f"  lon={pt[0]:.4f} lat={pt[1]:.4f} | post={post} | area={area} ha | loteo={nombre}")
