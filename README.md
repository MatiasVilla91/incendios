# Incendios Córdoba — Monitor de focos de calor 3D

Visualizador interactivo de incendios activos sobre las Sierras de Córdoba, en un globo 3D. Muestra los focos de calor de **NASA FIRMS** (satélite VIIRS) casi en tiempo real y, opcionalmente, los **vientos** que condicionan la propagación del fuego. Corre 100% en el navegador, sin backend.

> Primera fase de un proyecto de transparencia ambiental más amplio: cruzar incendios con cambio de uso del suelo y el Ordenamiento Territorial de Bosque Nativo (Ley 26.331). Ver `INCENDIOS_ROADMAP.md`.

---

## Características

| Módulo | Descripción |
|---|---|
| **Globo 3D** | Planeta con textura satelital real, centrado en las Sierras de Córdoba al iniciar |
| **Focos de incendio** | Focos de calor VIIRS 375 m de NASA FIRMS · selector de período (24 h a 10 días) · color según intensidad (FRP) · tooltip con detalle al pasar el mouse |
| **Vientos** | Flechas vectoriales sobre Córdoba con datos en tiempo real de Open-Meteo (viento a 10 m) |

---

## Cómo ejecutar

```bash
npx live-server
```

Abre `http://localhost:8080` en el navegador. No requiere instalar dependencias de frontend.

---

## Configurar la API key de FIRMS

Los focos de incendio vienen de NASA FIRMS, que requiere una *map key* gratuita:

1. Pedila en <https://firms.modaps.eosdis.nasa.gov/api/map_key/> (te llega al instante).
2. En `planeta.js`, reemplazá el valor de `FIRMS_MAP_KEY` por tu key.

Si la key falta o es inválida, el panel muestra "Falta map key".

---

## Estructura de archivos

```
proyecto-planeta/
├── index.html              # Estructura HTML: HUD, panel de control, leyendas
├── planeta.js              # Lógica CesiumJS: globo, focos FIRMS, vientos
├── style.css               # Estética radar de nave espacial
├── earth.jpg               # Textura del planeta
├── gee_nbr_sierras.js      # Script Google Earth Engine: cicatriz de fuego (dNBR)
├── INCENDIOS_ROADMAP.md    # Plan por fases del proyecto de transparencia
└── README.md               # Este archivo
```

---

## Configuración (en `planeta.js`)

| Constante | Qué hace | Valor por defecto |
|---|---|---|
| `FIRMS_MAP_KEY` | Tu map key de NASA FIRMS | *(reemplazar)* |
| `FIRMS_SOURCE` | Sensor satelital | `VIIRS_SNPP_NRT` |
| `FIRMS_AREA` | Caja geográfica `oeste,sur,este,norte` | `-66,-35.2,-61.5,-29.4` (Córdoba) |
| `FIRMS_DAYS` | Días hacia atrás (1–10) | `3` (lo cambian los botones del panel) |
| `CORDOBA` | Centro inicial de la cámara | `-31.4, -64.5` |

Para monitorear otra región, cambiá `FIRMS_AREA` y `CORDOBA`.

---

## APIs externas

### NASA FIRMS (Fire Information for Resource Management System)
- **Endpoint:** `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{source}/{area}/{days}`
- **Map key gratuita.** Límite: 5000 transacciones / 10 min.
- **Sensor:** VIIRS S-NPP 375 m, tiempo casi real (NRT).
- **Campos usados:** `latitude`, `longitude`, `frp`, `confidence`, `acq_date`, `acq_time`.

### Open-Meteo
- **Endpoint:** `https://api.open-meteo.com/v1/forecast`
- **Sin API key.**
- **Campos usados:** `wind_speed_10m`, `wind_direction_10m`.

---

## Qué muestra y qué no

**FRP (Fire Radiative Power)** es la potencia radiativa del fuego en megavatios: un proxy de intensidad, no de superficie quemada. Los focos VIIRS detectan calor en el momento del paso del satélite — un incendio puede no aparecer si pasó nublado o si el satélite no sobrevoló esa franja en la ventana elegida. Para el área quemada (cicatriz) se usa el análisis Sentinel-2 / dNBR del script `gee_nbr_sierras.js`.

---

## Créditos de datos

NASA FIRMS · Open-Meteo · Esri World Imagery · CesiumJS.
