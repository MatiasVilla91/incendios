import json
from pathlib import Path

with open("data/coincidencias_osm.json", encoding="utf-8") as f:
    coinc = json.load(f)

print("TOP 20 COINCIDENCIAS OSM:")
for c in coinc:
    lon   = c["lon"]
    lat   = c["lat"]
    area  = c["area_ha"]
    tipo  = c["osm_tipo"][:35]
    nombre = c["osm_nombre"][:40]
    year   = c["year"]
    print(f"  {year} | lon={lon} lat={lat} | area={area} ha | {tipo} | {nombre}")

# Ver distribucion de areas en los incendios 2024
print("\nDistribucion area_ha en incendios_2024.geojson (top 10):")
with open("data/incendios_2024.geojson", encoding="utf-8") as f:
    gee = json.load(f)

feats_with_osm = [f for f in gee["features"] if f["properties"].get("osm_desarrollo")]
feats_with_osm.sort(key=lambda f: f["properties"].get("area_ha", 0), reverse=True)
for f in feats_with_osm[:10]:
    p = f["properties"]
    print(f"  area={p.get('area_ha')} | tipo={p.get('osm_tipo','')[:30]} | nombre={p.get('osm_nombre','')[:40]}")

# Chequear el OSM que tiene el area mas grande
print("\nFeatures OSM de mayor tamaño (por bounds):")
with open("data/osm_desarrollo.geojson", encoding="utf-8") as f:
    osm = json.load(f)

import math
def area_bbox(geom):
    try:
        coords = geom["coordinates"]
        def flat_coords(c):
            if isinstance(c[0], (int,float)): return [c]
            return [pt for ring in c for pt in flat_coords(ring)]
        pts = flat_coords(coords)
        lons = [p[0] for p in pts]
        lats = [p[1] for p in pts]
        return (max(lons)-min(lons)) * (max(lats)-min(lats)) * 111 * 111
    except:
        return 0

big = sorted(osm["features"], key=lambda f: area_bbox(f["geometry"]), reverse=True)
for f in big[:10]:
    p = f["properties"]
    a = area_bbox(f["geometry"])
    print(f"  {a:.0f} km2 approx | {p.get('tipo')} | {p.get('nombre','')[:40]}")
