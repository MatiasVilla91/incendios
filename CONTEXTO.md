# Incendios Córdoba — Contexto del proyecto

## Qué es

App web científica de visualización de incendios forestales en Córdoba, Argentina.
Globo 3D interactivo con capas de datos reales, sin backend — 100% frontend estático.
Stack: CesiumJS 1.120.0 + HTML/CSS/JS puro.

Repositorio: `C:\Users\matia\Documents\INCENDIOS\proyecto-planeta`

---

## Arquitectura

```
index.html        — estructura HTML, panel de control, tooltips, divs de capas
style.css         — tema profesional con CSS variables (Inter font, naranja #e05d00)
planeta.js        — toda la lógica: Cesium viewer, capas, eventos, fetches
data/             — GeoJSONs generados (gitignoreados)
fire_scars_pipeline.py   — pipeline GEE para generar cicatrices históricas
enrich_with_idecor.py    — cruza cicatrices GEE con datos oficiales IDECOR
```

### Servidores de datos usados

| Fuente | URL | Protocolo |
|---|---|---|
| NASA FIRMS / VIIRS | `firms.modaps.eosdis.nasa.gov/api/area/csv/` | CSV + CORS proxy |
| Open-Meteo | `api.open-meteo.com/v1/forecast` | REST JSON |
| Esri World Imagery | `services.arcgisonline.com/...World_Imagery` | ArcGIS tiles |
| Esri Wayback | `wayback.maptiles.arcgis.com/...` | WMTS tiles |
| IDECOR WFS | `idecor-ws.mapascordoba.gob.ar/geoserver/idecor/wfs` | GeoJSON WFS 2.0 |
| IDECOR WMS | `idecor-ws.mapascordoba.gob.ar/geoserver/idecor/wms` | WMS tiles |
| IGN WMS | `wms.ign.gob.ar/geoserver/ign/wms` | WMS tiles |

---

## Capas implementadas

### 1. Focos activos — FIRMS/VIIRS
- Toggle `#fire-toggle`, selector 24h / 3d / 7d / 10d (`FIRMS_DAYS`)
- Función: `cargarIncendios()` → `createFireMarkers()`
- Color por FRP (Fire Radiative Power en MW): amarillo < 5 MW → rojo > 50 MW
- Hover: `infoEl` muestra ficha con coordenadas, fecha, confianza
- Problema CORS: ruta por proxies en `CORS_PROXIES[]`
- API key NASA FIRMS hardcodeada: `bea2d4de74297107f7358cf27fc4365b`

### 2. Vientos — Open-Meteo
- Toggle `#wind-toggle`
- Función: `cargarVientos()` → `createWindArrows()`
- Grilla 6×5 sobre Córdoba, flechas con `PolylineArrowMaterialProperty`
- Color por velocidad en m/s

### 3. Comparador temporal — Esri Wayback
- Toggle `#wayback-toggle`, selectores `#wayback-left` / `#wayback-right`
- Divide el viewport con `SplitDirection.LEFT / RIGHT` y `scene.splitPosition`
- Divisor arrastrable (`#split-line`)
- Fechas disponibles desde `waybackconfig.json` de S3 AWS

### 4. Cicatrices históricas — GEE Sentinel-2
- Toggle `#scar-toggle`, selector año 2018–2025
- Función: `cargarCicatrices(year)` → carga `data/incendios_{año}.geojson`
- Color por severidad dNBR: naranja (2) → rojo oscuro (4)
- Borde verde `#00ff88` si `bosque_nativo: true`
- Alpha 0.70 si `idecor_verificado: true`, 0.55 si no
- Clic: `showScarTooltip()` muestra ficha con severidad, área, cobertura IDECOR, localidad
- Datos generados con `fire_scars_pipeline.py` (ver sección Pipeline)

### 5. Bosque nativo — IDECOR WMS
- Toggle `#otbn-toggle`
- Función: `cargarBosqueNativo()`
- WMS `idecor:mcv_ambiente_2023_2024_vectorizado` filtrado por `categoria LIKE 'Bosque%' OR 'Matorral%'`
- CQL_FILTER en los parámetros WMS (compatible con GeoServer)
- Nota: es cobertura vegetal 2023/24, no OTBN legal (Categorías I/II). Ver sección OTBN.

### 6. División política — IGN + IDECOR
- Toggle `#divpol-toggle`
- Función: `cargarDivisionPolitica()`
- Provincias argentinas: WMS IGN `provincia` (tiles, sin CORS)
- Departamentos Córdoba: GeoJSON local `data/departamentos_cordoba.geojson`
  - Descargado de IDECOR WFS con `srsName=EPSG:4326`
  - 26 departamentos con nombres en Title Case
- Implementación de bordes: **polylines** `clampToGround: true` (visibles)
  + polígonos con alpha 0.01 como hit targets para hover (limitación Cesium: polygon.outline no funciona con clampToGround)
- Hover: `deptHoverMap` (Map entity.id → nombre), muestra `#dept-info` tooltip

---

## Pipeline de datos

### fire_scars_pipeline.py — Cicatrices GEE

Genera `data/incendios_{año}.geojson` con cicatrices de incendios de Córdoba.

```bash
python fire_scars_pipeline.py --project incendios-499400 --scale 500 --min-area 50
```

- **Proyecto GCP:** `incendios-499400` (non-commercial Earth Engine)
- **Satélite:** Sentinel-2 SR + Cloud Score+
- **Índice:** dNBR (differenced Normalized Burn Ratio)
- **Severidades:** 2 (moderada-baja), 3 (moderada-alta), 4 (severa)
- **Área mínima:** 50 ha
- **Años:** 2018–2025
- **CRS salida:** WGS84 (EPSG:4326)
- **Paginación:** `toList()` por bloques de 500 features

Propiedades de cada polígono GeoJSON:
- `severidad`: int 2–4
- `severidad_label`: string ("moderada_baja", "moderada_alta", "severa")
- `area_ha`: float
- `year`: int

### enrich_with_idecor.py — Cruce con datos IDECOR

Enriquece los GeoJSONs con datos oficiales de IDECOR.

```bash
python enrich_with_idecor.py
python enrich_with_idecor.py --years 2023 2024
```

- Descarga `area_quemada_{año}` de IDECOR WFS (EPSG:22174 → WGS84 via pyproj)
- Intersección espacial con shapely
- Agrega a cada polígono GEE:
  - `idecor_verificado`: bool
  - `bosque_nativo`: bool (detecta Monte, Matorral, Arbustal)
  - `coberturas_idecor`: string (lista de coberturas IDECOR)
  - `localidad_idecor`: string
  - `departamento_idecor`: string
- Guarda referencia en `data/area_quemada_{año}.geojson`
- Requiere: `pyproj`, `shapely`

### Datos disponibles en IDECOR WFS

Layers relevantes accesibles via `idecor-ws.mapascordoba.gob.ar/geoserver/idecor/wfs`:

| Layer | Descripción |
|---|---|
| `idecor:departamentos` | 26 departamentos de Córdoba |
| `idecor:area_quemada_{año}` | Áreas quemadas oficiales (2021–2025) |
| `idecor:mcv_ambiente_2023_2024_vectorizado` | Cobertura vegetal (WMS) |
| `idecor:loteos_muni_aprobados` | Loteos municipales aprobados |
| `idecor:loteos_muni_autorizados` | Loteos municipales autorizados |

CRS nativo de IDECOR: **EPSG:22174** (Gauss-Krüger Argentina Faja 4). Usar `srsName=EPSG:4326` para que el WFS reproyecte on-the-fly.

---

## Gotchas conocidos

- **polygon.outline + clampToGround = invisible** — limitación de Cesium documentada. Solución: polylines separadas para bordes visibles, polígonos invisibles (alpha 0.01) para picking.
- **CORS en FIRMS** — la API no envía headers CORS. Se usa lista de proxies con fallback.
- **IGN WFS** (`wfs.ign.gob.ar`) — DNS no resuelve en algunos entornos. Workaround: usar IGN **WMS** (`wms.ign.gob.ar`) que sí funciona.
- **Windows encoding** — IDECOR devuelve UTF-8 válido pero la consola Windows (cp1252) lo muestra garbled. Los archivos guardados están correctos. Usar `encoding='utf-8'` siempre en Python.
- **OTBN legal** — Las categorías de bosque nativo de la Ley 9.814 (I/II/III) no están disponibles como API pública. El WMS de cobertura vegetal es una aproximación. Si se consigue el shapefile, convertir con `ogr2ogr -t_srs EPSG:4326`.

---

## Ideas de desarrollo analítico

### A — Capa de recurrencia *(pipeline Python)*

Cruzar espacialmente todos los años (2018–2025) y contar cuántas veces se quemó cada zona.
Output: GeoJSON con campo `veces_quemado` (1–8). En el mapa, colorear por recurrencia.
**Por qué importa:** zonas multi-incendio son señal fuerte de incendio intencional para habilitar cambio de uso del suelo.

Implementación:
1. Cargar todos los GeoJSONs con shapely
2. Union por año → calcular intersecciones entre años
3. Para cada polígono resultado, contar en cuántos años aparece
4. Exportar a `data/recurrencia.geojson`

### B — Loteos IDECOR superpuestos *(próximo paso)*

IDECOR tiene `loteos_muni_aprobados` y `loteos_muni_autorizados` en su WFS.
Si un loteo se superpone con una cicatriz histórica → evidencia directa de "se quemó, luego se loteó".

Plan de implementación:
1. Descargar loteos via WFS (EPSG:4326) — guardar en `data/loteos_aprobados.geojson`
2. Mostrar como capa en CesiumJS (polígonos naranja con borde, semi-transparentes)
3. **Cruce Python** en `enrich_with_idecor.py`: detectar qué cicatrices tienen loteos posteriores
4. En el tooltip de cicatriz: añadir "⚠ Loteo aprobado post-incendio"
5. Toggle en el panel: "Loteos post-incendio"

Propiedades relevantes del WFS de loteos:
- `fecha_aprobacion` / `fecha_autorizacion`
- `localidad`, `departamento`
- `propietario` (si está disponible)
- `superficie_ha`

### C — Panel de análisis con Claude API *(requiere API key Anthropic)*

Al hacer clic en una cicatriz, un panel lateral llama a la API de Anthropic con el contexto completo y Claude genera una síntesis narrativa.

Contexto que se enviaría a Claude por cicatriz:
- Año del incendio, severidad, área en hectáreas
- Cobertura vegetal IDECOR (qué se quemó)
- Departamento y localidad
- Si fue verificado por IDECOR
- Si hay bosque nativo
- Si hay loteos superpuestos (una vez implementado B)
- Si hay recurrencia (una vez implementado A)

Casos de uso:
- Síntesis narrativa del evento para no-expertos
- Contexto legal (Ley 26.331 — OTBN, Ley 9.814 provincial)
- Señales de alerta ("este polígono tiene 3 de las 4 señales de incendio intencional")

Implementación: llamada `fetch` a `https://api.anthropic.com/v1/messages` desde el frontend.
La API key se carga desde una variable de entorno o un campo de configuración en el panel.

---

## Estado actual del mapa (junio 2025)

Capas activas y funcionando:
- [x] Focos VIIRS en tiempo casi real
- [x] Vientos Open-Meteo
- [x] Comparador Wayback (antes/después)
- [x] Cicatrices históricas 2018–2025 (GEE + IDECOR enrichment)
- [x] Bosque nativo IDECOR WMS
- [x] División política (provincias IGN + departamentos Córdoba con hover)

Próximos pasos en orden:
1. **B — Loteos IDECOR** (en curso)
2. **A — Recurrencia** (pipeline Python)
3. **C — Panel Claude API**
