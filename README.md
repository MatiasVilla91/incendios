# Incendios Córdoba

Mapa interactivo 3D de incendios en la provincia de Córdoba, Argentina (2018–2025).  
Cruza datos satelitales con información territorial para detectar patrones sospechosos de incendios intencionales vinculados a cambios ilegales de uso del suelo.

**Demo:** https://matiasvilla91.github.io/incendios/  
**Desarrollador:** [Matías Villa](https://msv18dev.vercel.app)

---

## Hipótesis

Algunos incendios en Córdoba no son accidentales. Se utilizan para degradar bosque nativo protegido por la Ley 9814 y habilitar cambios de uso del suelo — principalmente loteos y emprendimientos inmobiliarios (countries, campos de golf, resorts). La app cruza cicatrices de incendio con loteos municipales, bosque nativo OTBN, datos OSM y recurrencia histórica para detectar estas situaciones.

---

## Capas del mapa

| Capa | Fuente | Descripción |
|---|---|---|
| **Focos de incendio** | NASA FIRMS / VIIRS | Focos activos en tiempo casi real · color según potencia (FRP) · se actualiza cada 15 min |
| **Vientos** | Open-Meteo | Flechas vectoriales a 10 m · se actualiza cada 20 min |
| **Cicatrices históricas** | Sentinel-2 / GEE / dNBR | Polígonos de área quemada 2018–2025 · severidad · cruzados con IDECOR, OTBN y loteos |
| **Recurrencia** | Calculado localmente | Zonas quemadas 2+ veces en el mismo lugar · indica posible intencionalidad |
| **Bosque nativo** | IDECOR 2023/24 | Cobertura forestal nativa · zonas I (rojo), II (amarillo), III (verde) de la Ley de Bosques |
| **División política** | IGN / IDECOR | Provincias argentinas y 26 departamentos de Córdoba con etiquetas |
| **Desarrollo urbano** | OpenStreetMap | Urbanizaciones, barrios privados, campos de golf, resorts que coinciden con cicatrices |
| **Loteos municipales** | IDECOR | Loteos aprobados y autorizados · detecta loteos posteriores al incendio |
| **Casos de alerta** | Calculado localmente | Top 20 cicatrices más sospechosas rankeadas por score de alerta |
| **Análisis IA** | Claude (Anthropic) | Evaluación por IA de cada cicatriz o zona de recurrencia al hacer clic |
| **Comparador temporal** | Esri Wayback | Imágenes satelitales históricas para comparar antes/después del incendio |

---

## Funcionalidades

- **Análisis por IA**: hacé clic en cualquier cicatriz o zona de recurrencia → botón "Analizar con IA" → Claude analiza señales de alerta (bosque nativo, loteos, recurrencia, desarrollos de alto valor)
- **Casos de alerta**: ranking de las 20 cicatrices más sospechosas por score compuesto
- **Animación por año**: selector y botón ▶ para recorrer 2018–2025
- **Exportar**: descargá los datos en Excel (.xlsx) o PDF con el reporte completo incluyendo el análisis IA
- **Auto-refresh**: focos FIRMS y viento se actualizan solos sin recargar la página
- **Mapa restringido a Córdoba**: la cámara no puede salir de los límites de la provincia

---

## Arquitectura

```
Browser (GitHub Pages)
    │
    ├── index.html / planeta.js / style.css
    │       │
    │       ├── NASA FIRMS API → focos activos (cada 15 min)
    │       ├── Open-Meteo API → viento (cada 20 min)
    │       ├── Esri ArcGIS → imágenes satelitales base
    │       ├── Esri Wayback → imágenes históricas
    │       ├── IDECOR WFS → departamentos, loteos
    │       └── data/*.geojson → cicatrices, recurrencia, casos de alerta
    │
    └── Cloudflare Worker (proxy)
            └── Anthropic API (Claude Haiku) → análisis IA

Pipeline local (Python)
    fire_scars_pipeline.py → Google Earth Engine → data/incendios_{año}.geojson
    generar_recurrencia.py → data/recurrencia.geojson
    generar_coincidencias.py → data/coincidencias_osm.json
    generar_casos_alerta.py → data/casos_alerta.json
```

---

## Estructura de archivos

```
proyecto-planeta/
├── index.html                    # Estructura HTML, panel de control, tooltips
├── planeta.js                    # Lógica principal: CesiumJS, capas, IA, exportación
├── style.css                     # Estética dark / estilo radar
│
├── cloudflare-worker/
│   └── worker.js                 # Proxy para la API de Anthropic (key server-side)
│
├── .github/workflows/
│   └── actualizar-datos.yml      # GitHub Action: regenera recurrencia y casos cada lunes
│
├── data/                         # GeoJSONs servidos por GitHub Pages
│   ├── incendios_{2018..2025}.geojson   # Cicatrices por año (generadas por pipeline)
│   ├── recurrencia.geojson              # Zonas quemadas 2+ veces
│   ├── casos_alerta.json                # Top 20 casos más sospechosos
│   ├── coincidencias_osm.json           # OSM que coincide con cicatrices
│   ├── departamentos_cordoba.geojson    # Límites de departamentos
│   ├── loteos_aprobados.geojson         # Loteos municipales
│   ├── loteos_autorizados.geojson
│   ├── osm_desarrollo.geojson           # Desarrollos OSM
│   └── area_quemada_{año}.geojson       # Área quemada anual para comparador
│
├── fire_scars_pipeline.py        # Pipeline GEE: genera incendios_{año}.geojson
├── generar_recurrencia.py        # Calcula zonas de recurrencia
├── generar_coincidencias.py      # Cruza cicatrices con OSM
├── generar_casos_alerta.py       # Rankea cicatrices por score de alerta
├── enrich_with_idecor.py         # Enriquece cicatrices con datos IDECOR
├── enrich_osm.py                 # Enriquece cicatrices con datos OSM
├── agregar_loteos.py             # Cruza cicatrices con loteos municipales
└── gee_nbr_sierras.js            # Script GEE (editor web) para exploración manual
```

---

## Setup local

```bash
npx live-server
# Abre http://localhost:8080
```

No requiere instalación de dependencias de frontend (CesiumJS se carga desde CDN).

---

## Pipeline de datos (Python + GEE)

### 1. Instalar dependencias

```bash
pip install earthengine-api shapely
```

### 2. Autenticar Google Earth Engine (una sola vez)

Necesitás un proyecto Google Cloud registrado en https://earthengine.google.com

```bash
earthengine authenticate --project TU_PROYECTO_CLOUD
```

### 3. Generar cicatrices históricas

```bash
python fire_scars_pipeline.py --project TU_PROYECTO_CLOUD
# Genera: data/incendios_2018.geojson ... data/incendios_2025.geojson

# Solo un año con más detalle:
python fire_scars_pipeline.py --project TU_PROYECTO_CLOUD --years 2024 --scale 50

# Para años pesados (2024 = 100.000+ ha), exportar a Google Drive:
python fire_scars_pipeline.py --project TU_PROYECTO_CLOUD --mode drive --scale 20
```

### 4. Enriquecer y calcular capas derivadas

```bash
python enrich_with_idecor.py      # agrega bosque nativo, departamento, localidad
python agregar_loteos.py          # agrega loteo_post_incendio, loteo_superpuesto
python enrich_osm.py              # agrega osm_tipo, osm_nombre
python generar_recurrencia.py     # genera data/recurrencia.geojson
python generar_coincidencias.py   # genera data/coincidencias_osm.json
python generar_casos_alerta.py    # genera data/casos_alerta.json
```

### 5. Commitear y pushear

```bash
git add data/
git commit -m "actualizar datos"
git push
# GitHub Pages despliega en ~2 minutos
```

---

## Score de alerta (casos_alerta.json)

| Señal | Puntos |
|---|---|
| Bosque nativo quemado | +30 |
| Loteo municipal **posterior** al incendio | +50 |
| Loteo municipal superpuesto | +20 |
| Desarrollo de alto valor en la zona (golf, resort, hotel, estancia) | +15 |
| Área quemada (hasta 20.000 ha) | +1 por cada 1.000 ha |
| Recurrencia (zona quemada antes) | +25 por cada incendio adicional |

---

## Cálculo de cicatrices (dNBR)

```
NBR  = (B8 − B12) / (B8 + B12)   ← NIR y SWIR2 de Sentinel-2
dNBR = NBR_antes − NBR_después    ← positivo = pérdida de vegetación

Severidad:
  clase 2 — moderada-baja   dNBR [0.27 – 0.44]
  clase 3 — moderada-alta   dNBR [0.44 – 0.66]
  clase 4 — severa          dNBR > 0.66
```

---

## Proxy Cloudflare Worker (API key de Anthropic)

La API key de Claude **nunca aparece en el código público**. Vive como secreto en Cloudflare.

El código del Worker está en `cloudflare-worker/worker.js`.

**Para configurar:**
1. Crear Worker en dash.cloudflare.com → Workers & Pages → Create Worker
2. Pegar el contenido de `cloudflare-worker/worker.js`
3. Settings → Variables and Secrets → agregar secreto `ANTHROPIC_KEY` con la API key
4. Copiar la URL del worker y actualizar `WORKER_URL` en `planeta.js`

---

## Actualización automática de datos

**Datos en tiempo real** (automático, client-side):
- Focos FIRMS: cada 15 minutos
- Viento: cada 20 minutos

**Datos históricos** (GitHub Action):
- `.github/workflows/actualizar-datos.yml` corre cada lunes a las 6 AM UTC
- Regenera `recurrencia.geojson` y `casos_alerta.json` a partir de los GeoJSON existentes
- Commitea y pushea automáticamente si hay cambios

**Cicatrices nuevas** (manual):
- Requiere correr `fire_scars_pipeline.py` localmente con acceso a GEE
- No automatizable sin cuenta de servicio GEE

---

## APIs y fuentes de datos

| Fuente | Uso | Key requerida |
|---|---|---|
| NASA FIRMS | Focos activos VIIRS | Gratuita en firms.modaps.eosdis.nasa.gov |
| Open-Meteo | Viento en tiempo real | No |
| Google Earth Engine | Generación de cicatrices (pipeline) | Cuenta Google + proyecto Cloud |
| Esri ArcGIS / Wayback | Imágenes satelitales | No |
| IDECOR WFS | Departamentos, loteos, bosque nativo | No |
| OpenStreetMap | Urbanizaciones, desarrollos | No |
| Anthropic (Claude Haiku) | Análisis IA | Sí — vive en Cloudflare Worker |

---

## Despliegue

El mapa corre 100% estático desde GitHub Pages.

1. `git push` a `main`
2. GitHub → Settings → Pages → Source: `main` / `/ (root)`
3. URL: `https://matiasvilla91.github.io/incendios/`

Cada push despliega automáticamente en ~2 minutos.
