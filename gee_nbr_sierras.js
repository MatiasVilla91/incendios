/* ============================================================================
 *  CICATRIZ DE FUEGO — Sierras de Córdoba · Septiembre 2024
 *  Proyecto Planeta · Módulo Incendios · Fase 1
 * ----------------------------------------------------------------------------
 *  Calcula el dNBR (delta Normalized Burn Ratio) comparando Sentinel-2
 *  ANTES y DESPUÉS de la temporada de fuego de septiembre 2024, y dibuja
 *  la cicatriz del incendio sobre el mapa.
 *
 *  CÓMO USARLO:
 *    1. Activá Google Earth Engine (ver INCENDIOS_ROADMAP.md, Fase 0).
 *    2. Abrí https://code.earthengine.google.com
 *    3. Pegá TODO este archivo en el editor y dale "Run".
 *    4. Mirá el mapa: lo naranja/rojo es área quemada. Usá el panel de capas
 *       (arriba a la derecha del mapa) para prender/apagar cada capa.
 *
 *  NBR  = (NIR - SWIR2) / (NIR + SWIR2)   →  en Sentinel-2: (B8 - B12)/(B8 + B12)
 *  dNBR = NBR_antes - NBR_despues          →  cuanto más alto, más severa la quema
 * ========================================================================== */

// ── 1. Zona de estudio: Sierras de Córdoba ──────────────────────────────────
// Rectángulo que cubre el corazón serrano (Punilla / Sierras Chicas / Traslasierra).
// Coordenadas: [Oeste, Sur, Este, Norte]. Ajustá si querés otra zona.
var sierras = ee.Geometry.Rectangle([-65.6, -32.6, -64.2, -30.4]);

Map.centerObject(sierras, 9);

// ── 2. Ventanas temporales ──────────────────────────────────────────────────
// El 76% de lo quemado en 2024 fue en septiembre. Tomamos un "antes" (invierno,
// previo al fuego) y un "después" (post-temporada).
var preInicio  = '2024-07-15';
var preFin     = '2024-08-31';   // ANTES del pico de incendios
var postInicio = '2024-10-01';
var postFin    = '2024-11-15';   // DESPUÉS del pico de incendios

// ── 3. Máscara de nubes con Cloud Score+ (recomendado por Google) ───────────
// Cloud Score+ puntúa cada píxel de 0 (nube/sombra) a 1 (cielo despejado).
var csPlus = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
var QA_BAND = 'cs_cdf';
var CLEAR_THRESHOLD = 0.60;   // subí a 0.65 si quedan nubes; bajá si faltan datos

// ── 4. Función: compuesto Sentinel-2 limpio para una ventana de fechas ──────
function compuestoS2(inicio, fin) {
  var col = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(sierras)
    .filterDate(inicio, fin)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 60))
    .linkCollection(csPlus, [QA_BAND])
    .map(function (img) {
      // Enmascara nubes/sombras y escala la reflectancia (0–10000 → 0–1)
      return img.updateMask(img.select(QA_BAND).gte(CLEAR_THRESHOLD))
                .divide(10000);
    });
  // Mediana = compuesto robusto sin nubes
  return col.median().clip(sierras);
}

// ── 5. Función: NBR de una imagen ───────────────────────────────────────────
// normalizedDifference([NIR, SWIR2]) = (B8 - B12) / (B8 + B12)
function nbr(img) {
  return img.normalizedDifference(['B8', 'B12']).rename('NBR');
}

// ── 6. Cálculo ──────────────────────────────────────────────────────────────
var pre  = compuestoS2(preInicio,  preFin);
var post = compuestoS2(postInicio, postFin);

var nbrPre  = nbr(pre);
var nbrPost = nbr(post);

// dNBR: positivo = pérdida de vegetación (cicatriz). Escalado ×1000 (convención USGS).
var dNBR = nbrPre.subtract(nbrPost).multiply(1000).rename('dNBR');

// ── 7. Clasificación de severidad (umbrales USGS / Key & Benson 2006) ───────
//   < 100   : sin quema / rebrote
//   100-270 : quema baja
//   270-440 : quema moderada-baja
//   440-660 : quema moderada-alta
//   > 660   : quema severa
var severidad = ee.Image(0)
  .where(dNBR.gte(100).and(dNBR.lt(270)), 1)
  .where(dNBR.gte(270).and(dNBR.lt(440)), 2)
  .where(dNBR.gte(440).and(dNBR.lt(660)), 3)
  .where(dNBR.gte(660), 4)
  .clip(sierras)
  .rename('severidad')
  .selfMask();   // oculta los píxeles "sin quema" (clase 0)

// ── 8. Visualización ─────────────────────────────────────────────────────────
// Imagen real "antes" y "después" (color natural) para comparar a ojo.
var visRGB = { bands: ['B4', 'B3', 'B2'], min: 0, max: 0.3 };
Map.addLayer(pre,  visRGB, '1 · Antes (jul–ago 2024)', false);
Map.addLayer(post, visRGB, '2 · Después (oct–nov 2024)', false);

// dNBR crudo (gradiente)
Map.addLayer(dNBR,
  { min: -100, max: 800, palette: ['#0a2f1a', '#1f7a3d', '#f7f7b0', '#f59e0b', '#dc2626'] },
  '3 · dNBR (gradiente)', false);

// Severidad clasificada (lo más útil: muestra la cicatriz por niveles)
Map.addLayer(severidad,
  { min: 1, max: 4, palette: ['#fde047', '#fb923c', '#ea580c', '#b91c1c'] },
  '4 · Cicatriz por severidad', true);

// ── 9. Estimación de superficie quemada (ha) ────────────────────────────────
// Cuenta píxeles con quema moderada o mayor (severidad >= 2 ≈ dNBR >= 270).
var areaQuemada = severidad.gte(2).multiply(ee.Image.pixelArea()).divide(10000);
var totalHa = areaQuemada.reduceRegion({
  reducer:   ee.Reducer.sum(),
  geometry:  sierras,
  scale:     20,
  maxPixels: 1e13,
  bestEffort: true
});
print('Superficie quemada estimada (ha, severidad ≥ moderada):', totalHa);

// Leyenda en consola
print('Severidad → color:  1 baja (amarillo) · 2 mod-baja (naranja) · ' +
      '3 mod-alta (naranja oscuro) · 4 severa (rojo)');

// ── 10. Exportar la cicatriz (descomentá para usar) ─────────────────────────
// Opción A — raster GeoTIFF a tu Google Drive:
// Export.image.toDrive({
//   image: dNBR, description: 'dNBR_sierras_sep2024',
//   region: sierras, scale: 20, maxPixels: 1e13, folder: 'incendios_cordoba'
// });

// Opción B — polígonos vectoriales de la cicatriz (para cruzar con OTBN luego):
// var vectores = severidad.gte(2).selfMask()
//   .reduceToVectors({ geometry: sierras, scale: 20, maxPixels: 1e13,
//                      geometryType: 'polygon', eightConnected: false });
// Export.table.toDrive({
//   collection: vectores, description: 'cicatriz_poligonos_sep2024',
//   fileFormat: 'GeoJSON', folder: 'incendios_cordoba'
// });

/* ----------------------------------------------------------------------------
 *  SIGUIENTE PASO (Fase 3): portar esto a Python con la API de GEE para generar
 *  incendios.json automáticamente cada semana vía GitHub Actions, igual que
 *  train_seismic_model.py hace con los sismos.
 * -------------------------------------------------------------------------- */
