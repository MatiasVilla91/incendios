# Prompts para Claude Code — Histórico y comparación de incendios en Córdoba

Objetivo del proyecto: demostrar con evidencia satelital cómo zonas de las Sierras de
Córdoba pasan de **monte → incendio → loteo inmobiliario / soja**. La herramienta tiene
que permitir **comparar la misma parcela en distintos años** ("acá no había nada → fuego
→ country").

Pegá estos prompts en Claude Code **en orden**, uno por vez, dentro de la carpeta del repo.
Esperá a que termine y probá cada paso antes de pasar al siguiente.

> Decisiones de arquitectura ya tomadas (no hace falta que Claude Code las re-discuta):
> - **Comparación de imágenes históricas:** Esri Wayback (WMTS gratuito, imágenes fechadas, sin API key) sobre el globo CesiumJS existente, con el deslizador de comparación nativo de Cesium (`ImageryLayer.splitDirection` + `scene.splitPosition`).
> - **Detección de cicatrices de fuego:** pipeline Python con Google Earth Engine (Sentinel-2, dNBR) que exporta polígonos a GeoJSON en el repo.
> - **Zonas legales:** capa OTBN (Ley 9.814 / 26.331) de IDECOR.
> - **Sin backend:** todo se sirve estático (GitHub Pages); los datos pesados se precalculan y se commitean como GeoJSON.

---

## Prompt 0 — Contexto inicial (pegá esto primero, una sola vez)

```
Estás trabajando en un proyecto llamado "Incendios Córdoba": un globo 3D en CesiumJS
(archivos index.html, planeta.js, style.css) que muestra focos de calor de NASA FIRMS
y vientos sobre las Sierras de Córdoba, Argentina. Corre sin backend con `npx live-server`
y se publica en GitHub Pages.

El objetivo del proyecto es de transparencia ambiental: mostrar con imágenes satelitales
cómo zonas de monte nativo se queman y luego aparecen loteos/countries o cultivos de soja,
muchas veces sobre bosque protegido por la Ley 26.331.

Leé los archivos INCENDIOS_ROADMAP.md, README.md, planeta.js e index.html para entender
la base, la estética (radar verde sobre fondo negro #000805, fuente monospace) y el patrón
de capas (toggle en el panel + leyenda + función cargar/clear). Mantené ese estilo en todo
lo que agregues. No rompas las capas existentes (focos FIRMS, vientos). Confirmame que
entendiste la estructura antes de escribir código.
```

---

## Prompt 1 — Comparador de imágenes históricas (lo que más te importa)

```
Quiero comparar la MISMA zona de Córdoba en dos momentos distintos del tiempo, en alta
resolución, para ver el cambio monte → incendio → loteo/soja.

Implementá en planeta.js + index.html una nueva capa "Comparar en el tiempo" usando
Esri Wayback (World Imagery Wayback), que es un archivo gratuito de imágenes satelitales
fechadas servidas por WMTS, sin API key.

Requisitos:
1. Traé la lista de releases (fechas) disponibles de Esri Wayback desde su config público
   (https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json o el
   endpoint vigente). Si ese endpoint cambió, buscá el actual.
2. En el panel agregá dos selectores de fecha (IZQUIERDA y DERECHA) poblados con esas
   releases, ordenadas de más vieja a más nueva.
3. Cargá la imagen de la fecha IZQUIERDA como capa Cesium con
   ImageryLayer.splitDirection = Cesium.SplitDirection.LEFT, y la de la DERECHA con RIGHT.
4. Agregá un divisor vertical arrastrable sobre el globo que controle viewer.scene.splitPosition
   (mirá el ejemplo "Imagery Layers Split" de Cesium Sandcastle). Que funcione con mouse y touch.
5. Un toggle activa/desactiva todo el modo comparación. Al desactivarlo, se quitan las dos
   capas y vuelve la imagen satelital base.
6. Default sugerido: izquierda = una release ~2016-2018, derecha = la más reciente, centrado
   en las Sierras de Córdoba (ya hay una constante CORDOBA en planeta.js).

Mantené la estética del proyecto. Probalo con `npx live-server` y verificá que el deslizador
compara bien dos años distintos sobre la misma parcela.
```

---

## Prompt 2 — Pipeline histórico de cicatrices de fuego (GEE → GeoJSON)

```
Quiero un histórico de DÓNDE se quemó en Córdoba, año por año, para superponerlo al
comparador de imágenes.

Creá un script Python `fire_scars_pipeline.py` que use la API de Google Earth Engine
(earthengine-api) para, por cada año entre 2018 y el actual:
- Tomar Sentinel-2 (COPERNICUS/S2_SR_HARMONIZED), enmascarar nubes con Cloud Score+
  (GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED).
- Calcular un compuesto "antes" (jul-ago) y "después" (oct-nov) de la temporada de fuego.
- Calcular dNBR = NBR_antes - NBR_despues (NBR = (B8-B12)/(B8+B12)).
- Quedarse con dNBR >= 0.27 (quema moderada o mayor) dentro del bounding box de Córdoba
  (oeste -66, sur -35.2, este -61.5, norte -29.4).
- Vectorizar (reduceToVectors) y exportar los polígonos.

Salida: un archivo `incendios_historico.geojson` en la raíz del repo, con un campo "year"
y "severidad" por polígono. Si el archivo total es muy pesado, simplificá geometrías y/o
generá un GeoJSON por año en una carpeta data/.

Usá el script existente gee_nbr_sierras.js como referencia de la lógica (ya tiene los
umbrales y la zona). Documentá en el README cómo autenticar GEE (earthengine authenticate)
y cómo correrlo. Mostrame cómo correrlo localmente para generar el GeoJSON la primera vez.
```

---

## Prompt 3 — Superponer cicatrices y zonas OTBN al globo

```
Ahora mostrá en el globo Cesium las cicatrices históricas y las zonas legales de bosque.

1. Cargá `incendios_historico.geojson` (Prompt 2) como una capa con toggle "Cicatrices de
   fuego" y un selector de año. Pintá los polígonos según severidad (paleta de fuego del
   proyecto: #ffdd00 → #ff1111). Que se pueda prender junto con el comparador de imágenes
   del Prompt 1, para ver la cicatriz sobre el antes/después.
2. Conseguí la capa OTBN de Córdoba (Ordenamiento Territorial de Bosque Nativo, Ley 9.814 /
   26.331) desde IDECOR (geoportal/descargas de idecor.gob.ar o su WFS). Convertila a GeoJSON
   liviano y agregá un toggle "Bosque protegido (OTBN)" que pinte zona roja (Cat. I, intangible)
   y amarilla (Cat. II). Buscá el dato; si no encontrás descarga directa, decímelo y te paso la fuente.
3. Al hacer click en una cicatriz, mostrá una ficha: año del incendio, severidad, y si cae
   sobre zona roja/amarilla del OTBN (cruce espacial punto-en-polígono en el browser).

Mantené la estética y no rompas las capas existentes. Probá todo con live-server.
```

---

## Prompt 4 — (Opcional) Automatizar la actualización

```
Creá un GitHub Action que corra `fire_scars_pipeline.py` una vez por semana y commitee
el `incendios_historico.geojson` actualizado. Para autenticar GEE en CI, usá una cuenta de
servicio de Google Cloud guardada como secret del repo (GEE_SERVICE_ACCOUNT_JSON). Documentá
en el README cómo crear esa cuenta de servicio y cargar el secret.
```

---

## Tips para trabajar con Claude Code

- Pegá **un prompt por vez** y probá el resultado antes de seguir.
- Si algo se rompe, decile: *"esto da este error: <pegás el error>, arreglalo"*.
- Pedile que **no toque las capas que ya andan** (FIRMS, vientos) cuando agrega algo nuevo.
- Cuando termines un paso que te gusta: `git add -A && git commit -m "..."` para no perderlo.
- Si una fuente de datos (Wayback, IDECOR) cambió de URL, pedile que **busque la actual**
  en vez de inventarla.

## Caso piloto para probar la hipótesis

Cuando el comparador funcione, arrancá con un caso concreto y conocido: el incendio de
**Capilla del Monte / Los Cocos (septiembre 2024, ~42.000 ha)**. Comparás imagen previa vs.
posterior y ves si aparecen loteos sobre lo quemado.
```
