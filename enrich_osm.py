#!/usr/bin/env python3
"""
enrich_osm.py
=============
1. Descarga features de desarrollo urbano de OpenStreetMap (Overpass API)
   para el área de Córdoba / Sierras.
2. Guarda data/osm_desarrollo.geojson
3. Intersecta con cicatrices GEE → agrega osm_desarrollo, osm_tipo, osm_nombre
4. Genera data/coincidencias_osm.json con los casos más relevantes

Uso:
  python enrich_osm.py
  python enrich_osm.py --skip-download    # usa cache local si existe
  python enrich_osm.py --years 2019 2020  # solo esos años
"""

import argparse, json, sys, time, urllib.request, urllib.parse
from pathlib import Path
from shapely.geometry import shape

DATA_DIR  = Path("data")
OUT_OSM   = DATA_DIR / "osm_desarrollo.geojson"
OUT_COINC = DATA_DIR / "coincidencias_osm.json"
YEARS     = range(2018, 2026)

# Bounding box: sur, oeste, norte, este — cubre Sierras + Capital
BBOX = "-33.5,-65.5,-29.0,-63.0"

TIPO_LABELS = {
    "residential":       "Urbanización / Barrio privado",
    "commercial":        "Zona comercial",
    "industrial":        "Zona industrial",
    "construction":      "En construcción",
    "golf_course":       "Campo de golf",
    "sports_centre":     "Centro deportivo",
    "recreation_ground": "Área recreativa",
    "resort":            "Resort / Complejo turístico",
    "hotel":             "Hotel / Alojamiento",
    "camp_site":         "Camping / Área de acampe",
}

OVERPASS_QUERY = f"""
[out:json][timeout:120][bbox:{BBOX}];
(
  way["landuse"~"^(residential|commercial|industrial|construction)$"];
  way["leisure"~"^(golf_course|sports_centre|recreation_ground)$"];
  way["tourism"~"^(resort|hotel|camp_site)$"];
  relation["landuse"~"^(residential|commercial)$"];
  relation["leisure"="golf_course"];
);
out geom;
"""


def query_overpass(query):
    encoded = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(
        "https://overpass-api.de/api/interpreter",
        data=encoded,
        headers={"User-Agent": "incendios-cordoba-research/1.0"},
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=150) as r:
                return json.load(r)
        except Exception as e:
            if attempt < 2:
                print(f"  Reintento {attempt+1}/3: {e}")
                time.sleep(6)
            else:
                raise


def way_coords(geom_list):
    coords = [[pt["lon"], pt["lat"]] for pt in geom_list]
    if len(coords) >= 3 and coords[0] != coords[-1]:
        coords.append(coords[0])
    return coords


def element_to_feature(el):
    tags  = el.get("tags", {})
    tipo  = (tags.get("landuse") or tags.get("leisure") or
             tags.get("tourism") or tags.get("amenity") or "otro")
    nombre = tags.get("name") or tags.get("name:es") or ""
    props  = {
        "osm_id":     el.get("id"),
        "tipo":       tipo,
        "tipo_label": TIPO_LABELS.get(tipo, tipo),
        "nombre":     nombre,
    }

    if el["type"] == "way":
        coords = way_coords(el.get("geometry", []))
        if len(coords) < 4:
            return None
        geometry = {"type": "Polygon", "coordinates": [coords]}

    elif el["type"] == "relation":
        outer, inner = [], []
        for m in el.get("members", []):
            if m.get("type") != "way":
                continue
            coords = way_coords(m.get("geometry", []))
            if len(coords) < 4:
                continue
            (outer if m.get("role", "outer") == "outer" else inner).append(coords)
        if not outer:
            return None
        geometry = (
            {"type": "Polygon",      "coordinates": [outer[0]] + inner}
            if len(outer) == 1 else
            {"type": "MultiPolygon", "coordinates": [[r] for r in outer]}
        )
    else:
        return None

    return {"type": "Feature", "properties": props, "geometry": geometry}


def download_osm():
    print("  Consultando Overpass API (puede tardar 30-60 s)...")
    data     = query_overpass(OVERPASS_QUERY)
    elements = data.get("elements", [])
    print(f"  {len(elements)} elementos recibidos")

    features, skipped = [], 0
    for el in elements:
        feat = element_to_feature(el)
        if feat:
            features.append(feat)
        else:
            skipped += 1

    print(f"  {len(features)} convertidos a GeoJSON ({skipped} sin geometría útil)")

    fc = {"type": "FeatureCollection", "features": features}
    with open(OUT_OSM, "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  Guardado en {OUT_OSM}")
    return features


SIERRAS_WEST  = -65.7
SIERRAS_EAST  = -64.0
SIERRAS_SOUTH = -34.0
SIERRAS_NORTH = -29.0
MIN_OSM_HA    = 2
MAX_OSM_HA    = 500
TIPOS_IGNORAR = {"construction", "school"}

def _area_ha(geom):
    import math
    try:
        lat   = geom.centroid.y
        scale = (111320 ** 2) * math.cos(math.radians(lat))
        return geom.area * scale / 10000
    except Exception:
        return 0

def build_shapes(features):
    shapes = []
    for feat in features:
        p    = feat.get("properties", {})
        tipo = p.get("tipo", "")
        if tipo in TIPOS_IGNORAR:
            continue
        try:
            geom = shape(feat["geometry"])
            if not geom.is_valid:
                geom = geom.buffer(0)
            c = geom.centroid
            if not (SIERRAS_WEST <= c.x <= SIERRAS_EAST and SIERRAS_SOUTH <= c.y <= SIERRAS_NORTH):
                continue
            area = _area_ha(geom)
            if area < MIN_OSM_HA or area > MAX_OSM_HA:
                continue
            shapes.append((geom, p))
        except Exception:
            pass
    return shapes


def centroid_of(feat_geom):
    try:
        g = shape(feat_geom)
        c = g.centroid
        return round(c.x, 5), round(c.y, 5)
    except Exception:
        return None, None


def enrich_year(year, osm_shapes):
    src = DATA_DIR / f"incendios_{year}.geojson"
    if not src.exists():
        print(f"  No existe {src}, saltando")
        return []

    with open(src, encoding="utf-8") as f:
        gee = json.load(f)

    coincidencias = []
    n_match = 0

    for feat in gee["features"]:
        try:
            scar = shape(feat["geometry"])
            if not scar.is_valid:
                scar = scar.buffer(0)
        except Exception:
            feat["properties"].update({"osm_desarrollo": False, "osm_tipo": "", "osm_nombre": ""})
            continue

        matches = []
        for osm_geom, props in osm_shapes:
            try:
                if scar.intersects(osm_geom):
                    matches.append(props)
            except Exception:
                pass

        if matches:
            n_match += 1
            tipos   = ", ".join(dict.fromkeys(m["tipo_label"] for m in matches if m["tipo_label"]))
            nombres = ", ".join(dict.fromkeys(m["nombre"]     for m in matches if m["nombre"]))
            feat["properties"].update({
                "osm_desarrollo": True,
                "osm_tipo":       tipos,
                "osm_nombre":     nombres,
            })
            # Recolectar para coincidencias_osm.json
            lon, lat = centroid_of(feat["geometry"])
            area = feat["properties"].get("area_ha", 0) or 0
            primer_nombre = next((m["nombre"] for m in matches if m["nombre"]), "")
            primer_tipo   = next((m["tipo_label"] for m in matches if m["tipo_label"]), "")
            label_parts = [f"{year}", f"{int(area):,} ha".replace(",", ".")]
            if primer_tipo:  label_parts.append(primer_tipo)
            if primer_nombre: label_parts.append(primer_nombre)
            coincidencias.append({
                "year":     year,
                "lon":      lon,
                "lat":      lat,
                "area_ha":  int(area),
                "osm_tipo": primer_tipo,
                "osm_nombre": primer_nombre,
                "label":    " · ".join(label_parts),
            })
        else:
            feat["properties"].update({"osm_desarrollo": False, "osm_tipo": "", "osm_nombre": ""})

    with open(src, "w", encoding="utf-8") as f:
        json.dump(gee, f, ensure_ascii=False, separators=(",", ":"))

    print(f"  {year}: {n_match}/{len(gee['features'])} cicatrices con desarrollo OSM")
    return coincidencias


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--years",         nargs="+", type=int, default=list(YEARS))
    parser.add_argument("--skip-download", action="store_true")
    args = parser.parse_args()

    DATA_DIR.mkdir(exist_ok=True)

    if args.skip_download and OUT_OSM.exists():
        print("Usando cache OSM local...")
        with open(OUT_OSM, encoding="utf-8") as f:
            features = json.load(f)["features"]
        print(f"  {len(features)} features en cache")
    else:
        print("Descargando OSM...")
        features = download_osm()

    if not features:
        print("Sin features OSM. Abortando.")
        return

    print("\nConstruyendo índice espacial...")
    osm_shapes = build_shapes(features)
    print(f"  {len(osm_shapes)} geometrias validas")

    print("\nIntersectando con cicatrices...")
    todas_coincidencias = []
    for year in args.years:
        coinc = enrich_year(year, osm_shapes)
        todas_coincidencias.extend(coinc)

    # Guardar coincidencias ordenadas por área (mayor primero), max 20
    todas_coincidencias.sort(key=lambda c: c["area_ha"], reverse=True)
    top = todas_coincidencias[:20]
    with open(OUT_COINC, "w", encoding="utf-8") as f:
        json.dump(top, f, ensure_ascii=False, indent=2)
    print(f"\nCoincidencias OSM guardadas en {OUT_COINC}: {len(top)} casos")
    for c in top[:8]:
        print(f"  {c['label']}")

    print("\nListo.")


if __name__ == "__main__":
    main()
