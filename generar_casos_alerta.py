"""
generar_casos_alerta.py
=======================
Genera data/casos_alerta.json: las cicatrices más sospechosas rankeadas
por un score de alerta compuesto de:
  - Recurrencia (zona quemada múltiples veces)
  - Bosque nativo quemado
  - Loteo post-incendio
  - Desarrollo de alto valor (golf, resort, hotel) en la zona
  - Área quemada (mayor = más impacto)

Uso:
  python generar_casos_alerta.py
  (requiere haber corrido generar_recurrencia.py primero)
"""

import json, math
from pathlib import Path
from shapely.geometry import shape
from shapely.ops import unary_union

DATA_DIR = Path("data")
OUT      = DATA_DIR / "casos_alerta.json"
YEARS    = range(2018, 2026)
TOP_N    = 20

OSM_ALTO_VALOR = {"golf", "golf_course", "resort", "hotel", "camp_site", "estancia"}

def centroid(feat):
    try:
        g = shape(feat["geometry"])
        c = g.centroid
        return round(c.x, 5), round(c.y, 5)
    except Exception:
        return None, None

def area_ha_geom(geom):
    try:
        lat   = geom.centroid.y
        scale = (111320 ** 2) * math.cos(math.radians(lat))
        return geom.area * scale / 10000
    except Exception:
        return 0

# ── Cargar recurrencia ────────────────────────────────────────────────────────
recurrencia_geoms = []
rec_path = DATA_DIR / "recurrencia.geojson"
if rec_path.exists():
    with open(rec_path, encoding="utf-8") as f:
        rec_fc = json.load(f)
    for feat in rec_fc["features"]:
        try:
            g = shape(feat["geometry"])
            if not g.is_valid:
                g = g.buffer(0)
            recurrencia_geoms.append((g, feat["properties"]["veces_quemado"]))
        except Exception:
            pass
    print(f"Recurrencia: {len(recurrencia_geoms)} zonas cargadas")
else:
    print("recurrencia.geojson no encontrado — correr generar_recurrencia.py")

def get_recurrencia(geom):
    """Máxima recurrencia para una cicatriz dada."""
    max_veces = 1
    try:
        for rg, veces in recurrencia_geoms:
            if geom.intersects(rg):
                inter_ha = area_ha_geom(geom.intersection(rg))
                if inter_ha > 5:
                    max_veces = max(max_veces, veces)
    except Exception:
        pass
    return max_veces

# ── Procesar cada año ─────────────────────────────────────────────────────────
candidatos = []

for year in YEARS:
    path = DATA_DIR / f"incendios_{year}.geojson"
    if not path.exists():
        continue
    with open(path, encoding="utf-8") as f:
        fc = json.load(f)

    for feat in fc["features"]:
        p   = feat["properties"]
        lon, lat = centroid(feat)
        if lon is None:
            continue

        area       = p.get("area_ha", 0) or 0
        bosque     = bool(p.get("bosque_nativo"))
        loteo_post = bool(p.get("loteo_post_incendio"))
        loteo_sup  = bool(p.get("loteo_superpuesto"))
        osm_tipo   = (p.get("osm_tipo") or "").lower()
        localidad  = p.get("localidad_idecor") or p.get("departamento_idecor") or ""
        nombre_loteo = p.get("nombre_loteo") or ""

        osm_alto_valor = any(k in osm_tipo for k in OSM_ALTO_VALOR)

        # Score
        score = 0
        if bosque:        score += 30
        if loteo_post:    score += 50
        if loteo_sup:     score += 20
        if osm_alto_valor: score += 15
        score += min(int(area / 1000), 20)   # hasta +20 por tamaño

        # La recurrencia se agrega al score pero requiere intersection (costoso)
        # Usamos un flag preliminar — la recurrencia real se calcula solo para top candidatos
        if score == 0:
            continue

        candidatos.append({
            "year": year, "lon": lon, "lat": lat,
            "area_ha": round(area, 0),
            "bosque_nativo": bosque,
            "loteo_post": loteo_post,
            "loteo_sup": loteo_sup,
            "osm_alto_valor": osm_alto_valor,
            "osm_tipo": p.get("osm_tipo") or "",
            "nombre_loteo": nombre_loteo,
            "localidad": localidad,
            "score_base": score,
            "_feat": feat,
        })

print(f"\n{len(candidatos)} candidatos con score > 0")

# ── Agregar recurrencia a los top candidatos ──────────────────────────────────
candidatos.sort(key=lambda c: c["score_base"], reverse=True)
top_candidatos = candidatos[:TOP_N * 3]  # evaluar 3× más de lo necesario

print("Calculando recurrencia para candidatos...")
for c in top_candidatos:
    try:
        geom = shape(c["_feat"]["geometry"])
        if not geom.is_valid:
            geom = geom.buffer(0)
        veces = get_recurrencia(geom)
    except Exception:
        veces = 1
    c["recurrencia"] = veces
    c["score"] = c["score_base"] + (veces - 1) * 25  # +25 por cada vez extra quemada

# ── Ordenar, deduplicar y exportar ───────────────────────────────────────────
top_candidatos.sort(key=lambda c: c["score"], reverse=True)

# Deduplicar: evitar dos cicatrices del mismo punto (mismo año y coordenadas similares)
seen = set()
final = []
for c in top_candidatos:
    key = (c["year"], round(c["lon"], 1), round(c["lat"], 1))
    if key in seen:
        continue
    seen.add(key)
    final.append({
        "year":          c["year"],
        "lon":           c["lon"],
        "lat":           c["lat"],
        "area_ha":       int(c["area_ha"]),
        "bosque_nativo": c["bosque_nativo"],
        "loteo_post":    c["loteo_post"],
        "loteo_sup":     c["loteo_sup"],
        "osm_alto_valor": c["osm_alto_valor"],
        "osm_tipo":      c["osm_tipo"],
        "nombre_loteo":  c["nombre_loteo"],
        "localidad":     c["localidad"],
        "recurrencia":   c["recurrencia"],
        "score":         c["score"],
    })
    if len(final) >= TOP_N:
        break

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(final, f, ensure_ascii=False, indent=2)

print(f"\nTop {len(final)} casos exportados → {OUT}")
print("\nRanking:")
for i, c in enumerate(final, 1):
    tags = []
    if c["recurrencia"] >= 2: tags.append(f"{c['recurrencia']}x")
    if c["bosque_nativo"]:    tags.append("bosque")
    if c["loteo_post"]:       tags.append("LOTEO POST")
    if c["osm_alto_valor"]:   tags.append(c["osm_tipo"][:20])
    loc = c["localidad"] or "sin localidad"
    print(f"  {i:2d}. {c['year']} · {c['area_ha']:,} ha · {loc} · score={c['score']} [{', '.join(tags)}]")
