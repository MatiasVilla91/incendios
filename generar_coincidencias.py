"""
generar_coincidencias.py
========================
Genera coincidencias_osm.json con un criterio estricto:
solo casos donde el feature OSM queda DENTRO de la cicatriz
(intersección >= 30% del área del feature OSM).

Usa la geometría real para calcular áreas (no area_ha del campo).
"""

import json, math
from pathlib import Path
from shapely.geometry import shape

DATA_DIR = Path("data")
OUT      = DATA_DIR / "coincidencias_osm.json"
YEARS    = range(2018, 2026)

SIERRAS_WEST  = -65.7
SIERRAS_EAST  = -64.0
SIERRAS_SOUTH = -34.0
SIERRAS_NORTH = -29.0

MIN_OSM_HA    = 2      # ignorar features OSM menores a 2 ha (pequeños)
MAX_OSM_HA    = 500    # ignorar pueblos enteros
MIN_OVERLAP   = 0.30   # el OSM feature debe tener ≥30% de su área dentro de la cicatriz

TIPOS_IGNORAR = {"construction", "school", "industrial"}

TIPO_EMOJI = {
    "golf_course":       "⛳",
    "resort":            "🏨",
    "hotel":             "🏨",
    "camp_site":         "⛺",
    "residential":       "🏘",
    "commercial":        "🏪",
    "sports_centre":     "🏟",
    "recreation_ground": "🟢",
}

def in_sierras(lon, lat):
    return SIERRAS_WEST <= lon <= SIERRAS_EAST and SIERRAS_SOUTH <= lat <= SIERRAS_NORTH

def area_m2(geom):
    """Área aproximada en m² usando el área en grados² y conversión."""
    try:
        if not geom.is_valid:
            geom = geom.buffer(0)
        lat   = geom.centroid.y
        scale = (111320 ** 2) * math.cos(math.radians(lat))
        return geom.area * scale
    except:
        return 0

# ── Cargar OSM ─────────────────────────────────────────────────────────────
with open(DATA_DIR / "osm_desarrollo.geojson", encoding="utf-8") as f:
    osm_fc = json.load(f)

print(f"Features OSM totales: {len(osm_fc['features'])}")

# Filtrar: Sierras + tamaño razonable + tipo relevante
osm_shapes = []
for feat in osm_fc["features"]:
    p    = feat["properties"]
    tipo = p.get("tipo", "")
    if tipo in TIPOS_IGNORAR:
        continue
    try:
        g = shape(feat["geometry"])
        if not g.is_valid:
            g = g.buffer(0)
    except:
        continue
    c = g.centroid
    if not in_sierras(c.x, c.y):
        continue
    area_ha = area_m2(g) / 10000
    if area_ha < MIN_OSM_HA or area_ha > MAX_OSM_HA:
        continue
    nombre = p.get("nombre", "")
    # landuse=residential sin nombre es zona urbana genérica, no barrio identificable
    if tipo == "residential" and not nombre:
        continue
    osm_shapes.append({
        "geom":      g,
        "area_ha":   area_ha,
        "tipo":      tipo,
        "tipo_label": p.get("tipo_label", tipo),
        "nombre":    p.get("nombre", ""),
        "lon":       round(c.x, 5),
        "lat":       round(c.y, 5),
    })

print(f"Features OSM en Sierras ({MIN_OSM_HA}-{MAX_OSM_HA} ha): {len(osm_shapes)}")

# ── Intersectar con cicatrices ─────────────────────────────────────────────
todas = []

for year in YEARS:
    src = DATA_DIR / f"incendios_{year}.geojson"
    if not src.exists():
        continue
    with open(src, encoding="utf-8") as f:
        gee = json.load(f)

    n_match = 0
    for feat in gee["features"]:
        props = feat["properties"]
        try:
            scar = shape(feat["geometry"])
            if not scar.is_valid:
                scar = scar.buffer(0)
        except:
            continue

        c = scar.centroid
        if not in_sierras(c.x, c.y):
            continue

        bosque = props.get("bosque_nativo", False)

        for osm in osm_shapes:
            try:
                if not scar.intersects(osm["geom"]):
                    continue
                inter = scar.intersection(osm["geom"])
                if inter.is_empty:
                    continue
                inter_ha    = area_m2(inter) / 10000
                osm_area_ha = osm["area_ha"]
                overlap_frac = inter_ha / osm_area_ha if osm_area_ha > 0 else 0

                if overlap_frac < MIN_OVERLAP:
                    continue  # el feature OSM no queda suficientemente dentro

                n_match += 1
                scar_area_ha = area_m2(scar) / 10000

                emoji = TIPO_EMOJI.get(osm["tipo"], "◼")
                label_parts = [str(year)]
                if scar_area_ha > 0:
                    label_parts.append(f"{int(scar_area_ha):,} ha quemadas".replace(",", "."))
                label_parts.append(f"{emoji} {osm['tipo_label']}")
                if osm["nombre"]:
                    label_parts.append(osm["nombre"])

                todas.append({
                    "year":        year,
                    "lon":         osm["lon"],
                    "lat":         osm["lat"],
                    "scar_ha":     int(scar_area_ha),
                    "osm_ha":      round(osm_area_ha, 1),
                    "overlap_pct": round(overlap_frac * 100, 0),
                    "osm_tipo":    osm["tipo"],
                    "tipo_label":  osm["tipo_label"],
                    "nombre":      osm["nombre"],
                    "bosque":      bosque,
                    "label":       " · ".join(label_parts),
                })
            except Exception:
                pass

    print(f"  {year}: {n_match} coincidencias en Sierras (overlap >= {int(MIN_OVERLAP*100)}%)")

# ── Ordenar y deduplicar ───────────────────────────────────────────────────
def score(c):
    s = 0
    if c["bosque"]:                               s += 2000
    if c["osm_tipo"] == "golf_course":            s += 800
    if c["osm_tipo"] in ("resort", "hotel"):      s += 400
    if c["osm_tipo"] == "residential":            s += 300
    s += min(c["scar_ha"], 20000) / 10
    s += c["overlap_pct"] * 5
    return s

todas.sort(key=score, reverse=True)

seen = set()
dedup = []
for c in todas:
    key = (c["year"], c["nombre"], round(c["lon"], 2), round(c["lat"], 2))
    if key not in seen:
        seen.add(key)
        dedup.append(c)

top = dedup[:25]

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(top, f, ensure_ascii=False, indent=2)

print(f"\nCOINCIDENCIAS FINALES ({len(top)}):")
for c in top:
    b = " [BOSQUE NATIVO]" if c["bosque"] else ""
    print(f"  {c['year']} | {c['tipo_label'][:25]:25s} | {c['nombre'][:35]:35s} | "
          f"scar={c['scar_ha']} ha | osm={c['osm_ha']:.0f} ha | {c['overlap_pct']:.0f}%{b}")

print(f"\nGuardado en {OUT}")
