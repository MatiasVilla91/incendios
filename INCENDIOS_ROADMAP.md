# Proyecto Planeta — Módulo "Incendios Córdoba"

## Roadmap y arquitectura

> Sistema de transparencia que cruza **dónde se quemó** con **qué se construyó después**,
> sobre la base del globo 3D que ya tenés (Seismic Array · CesiumJS).
>
> Hipótesis a demostrar con evidencia: *parte de los incendios en las Sierras son
> intencionales y abren la puerta a loteos inmobiliarios o frontera agropecuaria
> sobre bosque nativo legalmente protegido.*

---

## 1. Por qué este proyecto, en números

Los datos respaldan la intuición y, sobre todo, **hay un hueco de transparencia que un proyecto independiente puede llenar**:

| Dato | Valor | Fuente |
|---|---|---|
| Superficie quemada en Córdoba, 2024 | **103.327 ha** (586 incendios) | IDECOR / Gobierno de Córdoba |
| Concentración temporal | **76% en septiembre 2024** | IDECOR |
| Mayor evento individual 2024 | **42.046 ha** (Capilla del Monte, Dolores, San Esteban, Los Cocos) | IDECOR |
| Superficie quemada 2025 (ene–oct) | **17.545 ha** (−80% vs. 2024) | Gobierno de Córdoba |
| Acumulado 2020–2024 | **~630.000 ha** | UNCiencia / CONICET |
| Bosque nativo declarado (OTBN) | **2.92 M ha**: 2.39 M rojas (Cat. I) + 0.53 M amarillas (Cat. II) | OTBN Ley 9.814 / Ley 26.331 |
| Bosque nativo original que queda | **3–5%** | CONICET |

**El hueco real:** la magnitud de 2025 bajó muchísimo, pero el patrón estructural sigue
(fuego → cambio de uso). Un mapa público que muestre *"acá se quemó y miren lo que se
construyó después"* sirve a periodistas, ONGs y vecinos, y no depende de que el gobierno
publique o deje de publicar datos.

---

## 2. La idea central: cruzar tres capas

```
   CAPA 1                CAPA 2                     CAPA 3
   Cicatriz de fuego  ×  Cambio de uso del suelo ×  OTBN (zonas legales)
   ───────────────       ───────────────────        ──────────────────
   ¿Dónde se quemó?      ¿Qué apareció después?      ¿Era ilegal hacerlo?
   Sentinel-2 / dNBR     Sentinel-2 t+1, t+2 años    Ley 26.331 (rojo/amarillo)

                              │
                              ▼
              ┌──────────────────────────────────┐
              │  ALERTA DE TRANSPARENCIA          │
              │  "Parcela quemada en sep-2024,    │
              │   loteo detectado en mar-2026,    │
              │   sobre zona ROJA (intangible)"   │
              └──────────────────────────────────┘
```

Cada capa por separado ya existe en algún portal. **El valor del proyecto es el cruce
automatizado y público**, que hoy nadie mantiene de forma abierta y continua.

---

## 3. Stack — reutilizando tu base

Tu proyecto ya resuelve el 70% de la infraestructura. No empezás de cero:

| Necesidad del módulo incendios | Ya lo tenés en Seismic Array |
|---|---|
| Globo 3D geográfico en el browser | **CesiumJS** (`planeta.js`) |
| Capas de datos en tiempo real sobre el globo | patrón de **vientos** (`cargarVientos` / `createWindArrows`) |
| Mapa de calor / celdas coloreadas por valor | patrón de **riesgo sísmico** (`renderRiskZones`) |
| Panel con toggles y leyendas | `index.html` + `style.css` (estética radar) |
| Pipeline Python que descarga → procesa → exporta JSON | `train_seismic_model.py` |
| Actualización automática programada | **GitHub Actions** (`update_predictions.yml`) |
| Hosting sin backend | GitHub Pages (rama `gh-pages`) |

Lo único nuevo que se suma al stack:

- **Google Earth Engine (GEE)** — procesamiento satelital gratuito en la nube. Calcula
  las cicatrices de fuego (dNBR) y el cambio de uso sin que descargues terabytes.
- **NASA FIRMS** — focos de calor activos (VIIRS 375 m) casi en tiempo real, vía API con
  map key gratuita. Es el equivalente "incendios" de lo que USGS es a los sismos.
- **IDECOR / geoservicios de Córdoba** — capa oficial del OTBN (zonas rojo/amarillo/verde)
  y del mapa de Cobertura y Uso del Suelo (3ra edición). Vía WMS/WFS o descarga.

### Diagrama de datos

```
  ┌─ TIEMPO REAL (browser, sin backend) ──────────────────────────┐
  │  NASA FIRMS API  ──► focos de calor VIIRS  ──► CesiumJS (capa) │
  └───────────────────────────────────────────────────────────────┘

  ┌─ ANÁLISIS PERIÓDICO (GEE + GitHub Actions, semanal) ──────────┐
  │  Sentinel-2 ─► dNBR cicatrices ─┐                              │
  │  Sentinel-2 t+1/t+2 ─► uso suelo├─► cruce ─► incendios.json    │
  │  OTBN (rojo/amarillo) ──────────┘            (lo lee el globo) │
  └───────────────────────────────────────────────────────────────┘
```

Mismo esquema que ya usás: dato pesado se procesa offline y se exporta a un JSON liviano
que el browser consume. Cero costo de servidor.

---

## 4. Plan por fases

### Fase 0 — Activar Google Earth Engine *(antes de empezar)*

Tenés cuenta Google de usuario, pero GEE ahora requiere un proyecto de Google Cloud
(gratis para uso no comercial / investigación):

1. Entrá a <https://earthengine.google.com> → **Get Started** / **Sign Up**.
2. Registrá un proyecto Cloud. Elegí el tipo **"Unpaid usage / Noncommercial &
   research"** — no pide tarjeta.
3. Cuando se apruebe (suele ser inmediato), abrí el editor en
   <https://code.earthengine.google.com>.
4. Pegás el script de la Fase 1 y dale **Run**.

### Fase 1 — Ver la cicatriz del fuego *(fin de semana 1)* ✅ *entregable incluido*

- Script GEE (`gee_nbr_sierras.js`) que calcula el **dNBR** antes/después de
  septiembre 2024 sobre las Sierras y dibuja la cicatriz.
- Objetivo: que veas el área quemada aparecer sobre el mapa con tus propios datos.
- **Resultado:** validación visual de que el método funciona. Exportás la cicatriz
  como GeoTIFF o como vector (polígonos de zonas quemadas).

### Fase 2 — Capa de incendios en vivo en tu globo *(fin de semana 2)* ✅ *entregable incluido*

- Nueva capa **"Incendios Córdoba"** en `planeta.js`, con toggle en el panel.
- Trae focos de calor de **NASA FIRMS** (VIIRS) sobre Argentina/Córdoba de los últimos
  días y los pinta sobre el globo, con la misma estética que los sismos.
- **Resultado:** el globo ya no es solo sísmico — muestra fuego activo en tiempo real.

### Fase 3 — Pipeline de cicatrices históricas *(2–3 semanas)*

- Portar la lógica de la Fase 1 a un script Python con la API de GEE
  (`fire_scars_pipeline.py`), análogo a `train_seismic_model.py`.
- Genera `incendios.json` con los polígonos de cicatrices por año (2019–2025).
- GitHub Action semanal que lo regenera (clonar `update_predictions.yml`).
- El globo carga `incendios.json` y dibuja las cicatrices como celdas/polígonos.

### Fase 4 — El cruce que prueba la hipótesis *(el corazón del proyecto)*

- Para cada cicatriz de fuego, mirar la **misma parcela 1–2 años después**:
  - ¿La vegetación se recuperó (rebrote natural)? → caso esperado, sin alarma.
  - ¿Apareció un patrón geométrico de loteo, calles, o cultivo? → **señal de cambio de uso**.
- Indicadores: caída sostenida de NDVI sin recuperación + bordes rectos + cercanía a
  ejido urbano. (Esto es heurístico; se afina con casos reales.)
- Cruzar con la capa **OTBN**: si el cambio ocurrió sobre zona **roja o amarilla**,
  marcarlo como **potencialmente ilegal** bajo Ley 26.331.

### Fase 5 — Herramienta pública de transparencia

- Panel de "casos": lista de parcelas quemadas + cambiadas + su estatus legal.
- Ficha por caso: imágenes antes/durante/después, fechas, categoría OTBN, link a
  descargar la evidencia.
- Exportable para periodistas y ONGs (FUNDEPS, Greenpeace, etc.).
- Opcional: alertas automáticas cuando se detecta un cambio nuevo sobre zona protegida.

---

## 5. Fuentes de datos (todas gratuitas, sin backend propio)

| Capa | Fuente | Acceso | Resolución |
|---|---|---|---|
| Focos de calor (tiempo real) | NASA FIRMS (VIIRS) | API con map key gratuita | 375 m |
| Cicatrices de fuego | Sentinel-2 vía GEE | `COPERNICUS/S2_SR_HARMONIZED` | 10–20 m |
| Cambio de uso del suelo | Sentinel-2 vía GEE | misma colección, multitemporal | 10–20 m |
| OTBN (zonas legales) | IDECOR / Sec. de Ambiente Córdoba | WMS/WFS o shapefile | vectorial |
| Cobertura y uso del suelo | IDECOR (3ra edición) | WMS / descarga | vectorial/raster |
| Mapa de vegetación de las Sierras | IDECOR / CET-UNC | WMS / descarga | vectorial |

---

## 6. Consideraciones importantes

**Rigor metodológico.** El dNBR muestra dónde bajó la señal vegetal, pero no *por qué*.
Distinguir incendio de tala o de sequía requiere combinar señales (fechas, focos FIRMS
coincidentes, forma del área). Documentar siempre el método para que la evidencia
resista escrutinio.

**Intencionalidad ≠ detección satelital.** Los satélites prueban el *cambio*
(quemado → construido sobre zona protegida), no la *intención* detrás del fuego. El
proyecto aporta evidencia objetiva; la atribución de responsabilidad es trabajo
periodístico/judicial posterior. Conviene encuadrarlo así para no exponerse.

**Falsos positivos.** Rebrote natural, cortafuegos, quemas controladas autorizadas y
nubes/sombras generan ruido. La Fase 4 necesita validación con casos reales conocidos
antes de publicar conclusiones.

**Datos oficiales como complemento, no como dependencia.** El valor del proyecto es
justamente ser independiente. Pero cruzar con IDECOR cuando publica fortalece la
credibilidad.

---

## 7. Próximos pasos concretos

1. Activar GEE (Fase 0, ~10 min).
2. Correr `gee_nbr_sierras.js` y ver la cicatriz de septiembre 2024 (Fase 1).
3. Abrir el globo con la nueva capa FIRMS y mirar fuego activo (Fase 2).
4. Decidir un **caso piloto** concreto (ej. el incendio de Capilla del Monte / Los Cocos,
   42.046 ha) para desarrollar el cruce de la Fase 4 con un ejemplo real.

---

*Documento de arranque · Proyecto Planeta — Módulo Incendios · construido sobre Seismic Array.*
