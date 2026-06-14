"""
analizar_osm.py
===============
Inspecciona osm_desarrollo.geojson para entender qué hay en las Sierras
y regenera coincidencias_osm.json con filtros significativos.
"""

import json, math
from pathlib import Path
from shapely.geometry import shape

DATA_DIR = Path("data")

# ── Límites geográficos de las Sierras de Córdoba ──────────────────────────
# Excluimos el área plana/pampa (lon > -64.0)
SIERRAS_WEST  = -65.7
SIERRAS_EAST  = -64.0
SIERRAS_SOUTH = -34.0
SIERRAS_NORTH = -29.0

# Tipos que NO son interesantes para nuestra análisis
TIPOS_IGNORAR = {"construction", "school"}  # edificios escolares, obras en general

# Área máxima para considerar un polígono OSM (excluye ciudades/pueblos enteros)
MAX_OSM_HA = 500   # > 500 ha probablemente es límite de localidad, no barrio privado

def centroid(geom_dict):
    try:
        g = shape(geom_dict)
        c = g.centroid
        return round(c.x, 5), round(c.y, 5)
    except:
        return None, None

def osm_area_ha(geom_dict):
    try:
        g = shape(geom_dict)
        if not g.is_valid:
            g = g.buffer(0)
        # Aproximación en grados² → km²: 1° lat ≈ 111 km, 1° lon ≈ 111*cos(lat) km
        lat = g.centroid.y
        factor = 111 * 111 * math.cos(math.radians(lat))
        return g.area * factor * 100  # km² → ha
    except:
        return 0

def in_sierras(lon, lat):
    return (SIERRAS_WEST <= lon <= SIERRAS_EAST and
            SIERRAS_SOUTH <= lat <= SIERRAS_NORTH)

# ── Cargar OSM ────────────────────────────────────────────────────────────
with open(DATA_DIR / "osm_desarrollo.geojson", encoding="utf-8") as f:
    osm_fc = json.load(f)

features_osm = osm_fc["features"]
print(f"Total OSM features: {len(features_osm)}")

# ── Análisis de tipos ─────────────────────────────────────────────────────
tipo_count = {}
for feat in features_osm:
    t = feat["properties"].get("tipo", "?")
    tipo_count[t] = tipo_count.get(t, 0) + 1
print("\nDistribución de tipos OSM:")
for t, n in sorted(tipo_count.items(), key=lambda x: -x[1]):
    print(f"  {t:25s}: {n}")

# ── Features de alta relevancia en las Sierras ───────────────────────────
HIGH_INTEREST = {"golf_course", "resort", "hotel", "camp_site"}

print("\nFeatures de ALTA RELEVANCIA en las Sierras (golf, resort, hotel):")
for feat in features_osm:
    p     = feat["properties"]
    tipo  = p.get("tipo", "")
    lon, lat = centroid(feat["geometry"])
    if lon is None: continue
    if tipo not in HIGH_INTEREST: continue
    if not in_sierras(lon, lat): continue
    a = osm_area_ha(feat["geometry"])
    print(f"  {tipo:20s} | {p.get('nombre','(sin nombre)')[:40]} | {a:.0f} ha | lon={lon} lat={lat}")

# ── Barrios privados / countries con nombre en las Sierras ───────────────
print("\nURBANIZACIONES con nombre en las Sierras (< 500 ha):")
for feat in features_osm:
    p    = feat["properties"]
    tipo = p.get("tipo", "")
    if tipo != "residential": continue
    nombre = p.get("nombre", "")
    lon, lat = centroid(feat["geometry"])
    if lon is None: continue
    if not in_sierras(lon, lat): continue
    a = osm_area_ha(feat["geometry"])
    if a > MAX_OSM_HA: continue  # excluir pueblos enteros
    if not nombre: continue  # sin nombre no es interesante
    print(f"  {a:6.0f} ha | {nombre[:50]} | lon={lon} lat={lat}")

# ── Re-generar coincidencias con filtros ─────────────────────────────────
print("\n\nRe-generando coincidencias filtradas...")

# Construir shapes OSM filtradas (Sierras + tamaño razonable)
osm_shapes_filtradas = []
for feat in features_osm:
    p    = feat["properties"]
    tipo = p.get("tipo", "")
    if tipo in TIPOS_IGNORAR: continue
    lon, lat = centroid(feat["geometry"])
    if lon is None: continue
    if not in_sierras(lon, lat): continue
    a = osm_area_ha(feat["geometry"])
    if a > MAX_OSM_HA: continue
    try:
        g = shape(feat["geometry"])
        if not g.is_valid: g = g.buffer(0)
        osm_shapes_filtradas.append((g, p, a))
    except:
        pass

print(f"OSM features en Sierras (< {MAX_OSM_HA} ha): {len(osm_shapes_filtradas)}")

YEARS = range(2018, 2026)
todas_coinc = []

for year in YEARS:
    src = DATA_DIR / f"incendios_{year}.geojson"
    if not src.exists(): continue
    with open(src, encoding="utf-8") as f:
        gee = json.load(f)

    n_match = 0
    for feat in gee["features"]:
        props = feat["properties"]
        try:
            scar = shape(feat["geometry"])
            if not g.is_valid: scar = scar.buffer(0)
        except:
            continue

        # Solo Sierras
        c = scar.centroid
        if not in_sierras(c.x, c.y): continue

        matches = []
        for osm_geom, osm_props, osm_area in osm_shapes_filtradas:
            try:
                if scar.intersects(osm_geom):
                    matches.append((osm_props, osm_area))
            except:
                pass

        if matches:
            n_match += 1
            area_scar = props.get("area_ha", 0) or 0
            bosque    = props.get("bosque_nativo", False)
            for osm_props, osm_area in matches:
                tipo_label = osm_props.get("tipo_label", "")
                nombre     = osm_props.get("nombre", "")
                tipo_raw   = osm_props.get("tipo", "")
                lon_s = round(c.x, 5)
                lat_s = round(c.y, 5)
                label_parts = [str(year)]
                if area_scar: label_parts.append(f"{int(area_scar):,} ha".replace(",","."))
                if tipo_label: label_parts.append(tipo_label)
                if nombre:     label_parts.append(nombre)
                todas_coinc.append({
                    "year":       year,
                    "lon":        lon_s,
                    "lat":        lat_s,
                    "area_ha":    int(area_scar),
                    "osm_tipo":   tipo_label,
                    "osm_nombre": nombre,
                    "tipo_raw":   tipo_raw,
                    "bosque":     bosque,
                    "label":      " · ".join(label_parts),
                })

    print(f"  {year}: {n_match} cicatrices con desarrollo OSM en Sierras")

# Priorizar: primero bosque nativo, luego golf/resort, luego por area
def score(c):
    s = 0
    if c["bosque"]: s += 1000
    if c["tipo_raw"] in ("golf_course", "resort"): s += 500
    if c["tipo_raw"] == "residential": s += 200
    s += min(c["area_ha"], 50000) / 100
    return s

todas_coinc.sort(key=score, reverse=True)

# Deduplicar (misma zona, mismo nombre)
seen = set()
dedup = []
for c in todas_coinc:
    key = (c["year"], c["osm_nombre"], round(c["lon"], 2), round(c["lat"], 2))
    if key not in seen:
        seen.add(key)
        dedup.append(c)

top = dedup[:20]
out_path = DATA_DIR / "coincidencias_osm.json"
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(top, f, ensure_ascii=False, indent=2)

print(f"\nNuevas coincidencias guardadas: {len(top)}")
for c in top[:15]:
    bosque_flag = " [BOSQUE]" if c["bosque"] else ""
    print(f"  {c['year']} | {c['osm_tipo'][:25]:25s} | {c['osm_nombre'][:35]:35s} | {c['area_ha']} ha{bosque_flag}")
