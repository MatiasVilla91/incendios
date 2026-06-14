"""
generar_recurrencia.py
======================
Calcula qué zonas se quemaron más de una vez entre 2018-2025.
Genera data/recurrencia.geojson con campo veces_quemado (int >= 2).

Uso:
  python generar_recurrencia.py
"""

import json, math
from pathlib import Path
from itertools import combinations
from shapely.geometry import shape, mapping
from shapely.ops import unary_union

DATA_DIR    = Path("data")
OUT         = DATA_DIR / "recurrencia.geojson"
YEARS       = range(2018, 2026)
MIN_AREA_HA = 5   # descartar fragmentos menores a 5 ha

def area_ha(geom):
    try:
        lat   = geom.centroid.y
        scale = (111320 ** 2) * math.cos(math.radians(lat))
        return geom.area * scale / 10000
    except Exception:
        return 0

# ── 1. Cargar y unir cicatrices por año ───────────────────────────────────────
print("Cargando cicatrices por año...")
unions = {}
for year in YEARS:
    path = DATA_DIR / f"incendios_{year}.geojson"
    if not path.exists():
        continue
    with open(path, encoding="utf-8") as f:
        fc = json.load(f)
    geoms = []
    for feat in fc["features"]:
        try:
            g = shape(feat["geometry"])
            if not g.is_valid:
                g = g.buffer(0)
            geoms.append(g)
        except Exception:
            pass
    if geoms:
        unions[year] = unary_union(geoms)
        print(f"  {year}: {len(geoms)} polígonos → unión OK")

years = sorted(unions.keys())
print(f"  Años con datos: {years}\n")

# ── 2. Zona quemada en >= N años distintos ────────────────────────────────────
# at_least_n = unión de todas las intersecciones de combos de tamaño n
def at_least_n(n):
    parts = []
    for combo in combinations(years, n):
        geom = unions[combo[0]]
        for y in combo[1:]:
            try:
                geom = geom.intersection(unions[y])
            except Exception:
                geom = geom.buffer(0).intersection(unions[y].buffer(0))
            if geom.is_empty:
                break
        if not geom.is_empty:
            parts.append(geom.buffer(0))
    return unary_union(parts) if parts else None

layers = {}
for n in range(2, len(years) + 1):
    print(f"  Calculando >= {n} veces... ", end="", flush=True)
    result = at_least_n(n)
    if result is None or result.is_empty:
        print("sin intersección")
        break
    layers[n] = result
    print(f"{area_ha(result):.0f} ha")

# ── 3. Zona quemada EXACTAMENTE N veces ───────────────────────────────────────
# exactly_n = at_least_n − at_least_(n+1)
print("\nCalculando zonas exactas...")
features = []
for n in sorted(layers.keys()):
    zone = layers[n]
    if n + 1 in layers:
        try:
            zone = zone.difference(layers[n + 1])
        except Exception:
            zone = zone.buffer(0).difference(layers[n + 1].buffer(0))
    if zone.is_empty:
        continue

    raw_geoms = (
        list(zone.geoms) if zone.geom_type in ("MultiPolygon", "GeometryCollection")
        else [zone]
    )
    count = 0
    for g in raw_geoms:
        if g.geom_type not in ("Polygon", "MultiPolygon") or g.is_empty:
            continue
        a = area_ha(g)
        if a < MIN_AREA_HA:
            continue
        features.append({
            "type": "Feature",
            "properties": {"veces_quemado": n, "area_ha": round(a, 1)},
            "geometry": mapping(g),
        })
        count += 1
    print(f"  {n}x: {count} polígonos")

# ── 4. Guardar ────────────────────────────────────────────────────────────────
fc = {"type": "FeatureCollection", "features": features}
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(fc, f, ensure_ascii=False, separators=(",", ":"))

print(f"\n{len(features)} zonas exportadas → {OUT}")
print("\nResumen:")
for n in sorted(set(f["properties"]["veces_quemado"] for f in features)):
    subset = [f for f in features if f["properties"]["veces_quemado"] == n]
    total  = sum(f["properties"]["area_ha"] for f in subset)
    print(f"  {n} veces: {len(subset):3d} polígonos · {total:,.0f} ha")
