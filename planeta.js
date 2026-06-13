// ── Cesium setup ──────────────────────────────────────────────────────────────
const _creditDiv = document.createElement('div');
_creditDiv.style.display = 'none';
document.body.appendChild(_creditDiv);

const viewer = new Cesium.Viewer('cesiumContainer', {
  terrainProvider:      new Cesium.EllipsoidTerrainProvider(),
  baseLayerPicker:      false,
  geocoder:             false,
  homeButton:           false,
  sceneModePicker:      false,
  navigationHelpButton: false,
  animation:            false,
  timeline:             false,
  fullscreenButton:     false,
  infoBox:              false,
  selectionIndicator:   false,
  creditContainer:      _creditDiv,
});

// Remove any default imagery and load Esri World Imagery (satellite, no API key)
// Uses the async factory API required by Cesium >= 1.107
viewer.imageryLayers.removeAll();
Cesium.ArcGisMapServerImageryProvider.fromUrl(
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'
).then(p => viewer.imageryLayers.addImageryProvider(p));

viewer.scene.globe.enableLighting     = false;
viewer.scene.globe.showGroundAtmosphere = true;
viewer.scene.fog.enabled              = false;

// Initial camera — looking down at Earth from ~18,000 km
viewer.camera.setView({
  destination:  Cesium.Cartesian3.fromDegrees(0, 20, 18000000),
  orientation:  { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
});

// ── Graticule ─────────────────────────────────────────────────────────────────
for (let lat = -60; lat <= 60; lat += 30) {
  const pts = [];
  for (let lng = -180; lng <= 180; lng += 3)
    pts.push(Cesium.Cartesian3.fromDegrees(lng, lat, 8000));
  viewer.entities.add({
    polyline: {
      positions: pts,
      width:     lat === 0 ? 1.5 : 0.5,
      material:  lat === 0
        ? Cesium.Color.fromCssColorString('#00ffaa').withAlpha(0.55)
        : Cesium.Color.fromCssColorString('#00ff44').withAlpha(0.15),
      clampToGround: false,
    },
  });
}
for (let lng = -180; lng <= 180; lng += 30) {
  const pts = [];
  for (let lat = -85; lat <= 85; lat += 3)
    pts.push(Cesium.Cartesian3.fromDegrees(lng, lat, 8000));
  viewer.entities.add({
    polyline: {
      positions: pts,
      width:     0.5,
      material:  Cesium.Color.fromCssColorString('#00ff44').withAlpha(0.15),
      clampToGround: false,
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function colorPorMagnitud(mag) {
  if (mag < 2.5) return Cesium.Color.fromCssColorString('#00ff88');
  if (mag < 4.5) return Cesium.Color.fromCssColorString('#ffdd00');
  if (mag < 6.0) return Cesium.Color.fromCssColorString('#ff6600');
  return Cesium.Color.fromCssColorString('#ff1111');
}

function tamañoPorMagnitud(mag) {
  return Math.max(4, mag * 3.5);
}

function windColor(speed) {
  if (speed <  5) return Cesium.Color.fromCssColorString('#44ddff');
  if (speed < 10) return Cesium.Color.fromCssColorString('#88ffaa');
  if (speed < 20) return Cesium.Color.fromCssColorString('#ffdd00');
  if (speed < 30) return Cesium.Color.fromCssColorString('#ff6600');
  return Cesium.Color.fromCssColorString('#ff2222');
}

function riskColor(r) {
  if (r < 0.15) return Cesium.Color.fromCssColorString('#003311');
  if (r < 0.30) return Cesium.Color.fromCssColorString('#66cc00');
  if (r < 0.50) return Cesium.Color.fromCssColorString('#ffdd00');
  if (r < 0.70) return Cesium.Color.fromCssColorString('#ff7700');
  return Cesium.Color.fromCssColorString('#ff1111');
}

function buildURL({ minMag, days, dateFrom, dateTo }) {
  const now = new Date();
  const end   = dateTo || now.toISOString().split('T')[0];
  let   start = dateFrom;
  if (!start) {
    const d = new Date(now);
    d.setDate(d.getDate() - days);
    start = d.toISOString().split('T')[0];
  }
  return `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` +
         `&starttime=${start}&endtime=${end}&minmagnitude=${minMag}&limit=5000&orderby=time`;
}

// ── Estado ────────────────────────────────────────────────────────────────────
const knownIds = new Set();
let alertTimer = null;
let currentParams = { minMag: 2.5, days: 7, dateFrom: null, dateTo: null };

// markers array stores { userData } for ETAS compatibility
const markers    = [];
const eqPoints   = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());

function clearMarkers() {
  eqPoints.removeAll();
  markers.length = 0;
}

// ── Cargar terremotos ─────────────────────────────────────────────────────────
async function cargarTerremotos(params) {
  const loadingMsg = document.getElementById('loading-msg');
  const countMsg   = document.getElementById('count-msg');
  const countEl    = document.getElementById('count');
  const applyBtn   = document.getElementById('apply-btn');

  applyBtn.disabled        = true;
  loadingMsg.style.display = 'block';
  countMsg.style.display   = 'none';
  clearMarkers();

  try {
    const res  = await fetch(buildURL(params));
    const data = await res.json();

    for (const f of data.features) {
      const [lng, lat, depth] = f.geometry.coordinates;
      const mag = f.properties.mag;
      if (!mag || mag < 0) continue;

      knownIds.add(f.id);

      const id = {
        mag:         mag.toFixed(1),
        rawMag:      mag,
        lat, lng,
        timestamp:   f.properties.time,
        lugar:       f.properties.place || 'Ubicación desconocida',
        fecha:       new Date(f.properties.time).toLocaleDateString('es-ES'),
        profundidad: depth != null ? Math.round(depth) + ' km' : '—',
      };

      eqPoints.add({
        position:                  Cesium.Cartesian3.fromDegrees(lng, lat, 8000),
        pixelSize:                 tamañoPorMagnitud(mag),
        color:                     colorPorMagnitud(mag),
        outlineColor:              Cesium.Color.BLACK.withAlpha(0.4),
        outlineWidth:              1,
        id,
      });
      markers.push({ userData: id });
    }

    countEl.textContent      = eqPoints.length;
    loadingMsg.style.display = 'none';
    countMsg.style.display   = 'block';

    if (document.getElementById('risk-toggle')?.checked) actualizarRiesgo();
  } catch (e) {
    loadingMsg.textContent = 'Error al cargar datos';
  } finally {
    applyBtn.disabled = false;
  }
}

// ── Alertas ───────────────────────────────────────────────────────────────────
async function checkAlerts() {
  const minMag = parseFloat(document.getElementById('alert-mag').value);
  const now    = new Date();
  const past   = new Date(now - 30 * 60 * 1000);
  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` +
              `&starttime=${past.toISOString()}&endtime=${now.toISOString()}` +
              `&minmagnitude=${minMag}&limit=10&orderby=time`;
  try {
    const res    = await fetch(url);
    const data   = await res.json();
    const nuevos = data.features.filter(f => !knownIds.has(f.id));
    if (nuevos.length > 0) {
      nuevos.forEach(f => knownIds.add(f.id));
      const f = nuevos[0];
      mostrarAlerta(
        `M${f.properties.mag.toFixed(1)} — ${f.properties.place || 'Ubicación desconocida'}`,
        new Date(f.properties.time).toLocaleString('es-ES')
      );
    }
  } catch (e) {}
}

function mostrarAlerta(titulo, fecha) {
  document.getElementById('alert-title').textContent = '⚠ Nuevo sismo detectado';
  document.getElementById('alert-body').textContent  = `${titulo} · ${fecha}`;
  document.getElementById('alert-notif').style.display = 'flex';
  if (Notification.permission === 'granted')
    new Notification('⚠ Nuevo sismo', { body: titulo });
}

// ── Geocodificación inversa (lazy + cache) ────────────────────────────────────
const _geoCache = new Map();
async function getLocationName(lat, lng) {
  const key = `${lat},${lng}`;
  if (_geoCache.has(key)) return _geoCache.get(key);
  try {
    const res  = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=es`
    );
    const data = await res.json();
    const name = [data.countryName, data.principalSubdivision]
      .filter(Boolean).join(' · ') || '—';
    _geoCache.set(key, name);
    return name;
  } catch { return '—'; }
}

// ── Hover tooltip ─────────────────────────────────────────────────────────────
const infoEl  = document.getElementById('eq-info');
const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

handler.setInputAction((movement) => {
  const picked = viewer.scene.pick(movement.endPosition);
  const x = movement.endPosition.x + 16;
  const y = movement.endPosition.y - 16;

  if (Cesium.defined(picked) && picked.id && picked.id.mag !== undefined) {
    // Sismo
    const { mag, lugar, fecha, profundidad } = picked.id;
    infoEl.innerHTML     = `<strong>M${mag}</strong> — ${lugar}<br><small>${fecha} · Prof: ${profundidad}</small>`;
    infoEl.style.display = 'block';
    infoEl.style.left    = x + 'px';
    infoEl.style.top     = y + 'px';
    viewer.scene.canvas.style.cursor = 'crosshair';

  } else if (Cesium.defined(picked) && picked.id && picked.id._risk) {
    // Zona de riesgo sísmico
    const { lat, lng, risk, count, maxMag } = picked.id._risk;
    const pct   = (risk * 100).toFixed(0);
    const latS  = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
    const lngS  = `${Math.abs(lng).toFixed(1)}°${lng >= 0 ? 'E' : 'O'}`;
    const nivel = risk < 0.5 ? 'Moderado' : risk < 0.7 ? 'Alto' : 'Crítico';
    const sismos = count !== '—' ? `${count} sismos · ` : '';
    const mmax   = maxMag !== '—' ? `M${(+maxMag).toFixed(1)}` : '—';

    const setTooltip = (location) => {
      infoEl.innerHTML = `<strong>${nivel} · ${pct}%</strong> — ${location}`
        + `<br><small>${latS} ${lngS} · ${sismos}Mag. máx: ${mmax}</small>`;
    };

    setTooltip('…');
    infoEl.style.display = 'block';
    infoEl.style.left    = x + 'px';
    infoEl.style.top     = y + 'px';
    viewer.scene.canvas.style.cursor = 'help';

    getLocationName(lat, lng).then(location => {
      if (infoEl.style.display === 'block') setTooltip(location);
    });

  } else {
    infoEl.style.display = 'none';
    viewer.scene.canvas.style.cursor = '';
  }
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

// Tap en mobile: misma lógica que hover pero con LEFT_CLICK
const tapHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
tapHandler.setInputAction((click) => {
  const picked = viewer.scene.pick(click.position);
  const x = Math.min(click.position.x + 16, window.innerWidth  - 220);
  const y = Math.max(click.position.y - 16, 10);

  if (Cesium.defined(picked) && picked.id && picked.id.mag !== undefined) {
    const { mag, lugar, fecha, profundidad } = picked.id;
    infoEl.innerHTML     = `<strong>M${mag}</strong> — ${lugar}<br><small>${fecha} · Prof: ${profundidad}</small>`;
    infoEl.style.display = 'block';
    infoEl.style.left    = x + 'px';
    infoEl.style.top     = y + 'px';
  } else if (Cesium.defined(picked) && picked.id && picked.id._risk) {
    const { lat, lng, risk, count, maxMag } = picked.id._risk;
    const pct   = (risk * 100).toFixed(0);
    const latS  = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
    const lngS  = `${Math.abs(lng).toFixed(1)}°${lng >= 0 ? 'E' : 'O'}`;
    const nivel = risk < 0.5 ? 'Moderado' : risk < 0.7 ? 'Alto' : 'Crítico';
    const sismos = count !== '—' ? `${count} sismos · ` : '';
    const mmax   = maxMag !== '—' ? `M${(+maxMag).toFixed(1)}` : '—';
    infoEl.innerHTML = `<strong>${nivel} · ${pct}%</strong> — …`
      + `<br><small>${latS} ${lngS} · ${sismos}Mag. máx: ${mmax}</small>`;
    infoEl.style.display = 'block';
    infoEl.style.left    = x + 'px';
    infoEl.style.top     = y + 'px';
    getLocationName(lat, lng).then(loc => {
      if (infoEl.style.display === 'block')
        infoEl.innerHTML = infoEl.innerHTML.replace('…', loc);
    });
  } else {
    infoEl.style.display = 'none';
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// ── Vientos ───────────────────────────────────────────────────────────────────
const WIND_GRID = (() => {
  const pts = [];
  for (let lat = -75; lat <= 75; lat += 30)
    for (let lng = -165; lng <= 165; lng += 30)
      pts.push({ lat, lng });
  return pts;
})();

const windEntities = [];

function clearWindEntities() {
  for (const e of windEntities) viewer.entities.remove(e);
  windEntities.length = 0;
}

function createWindArrows(data) {
  clearWindEntities();
  for (const { lat, lng, speed, direction } of data) {
    if (speed < 0.5) continue;

    const len    = Math.min(1400000, Math.max(250000, speed * 45000));
    const toDir  = ((direction + 180) % 360) * Math.PI / 180;
    const dLat   = (len / 111111) * Math.cos(toDir);
    const cosLat = Math.cos(lat * Math.PI / 180) || 0.001;
    const dLng   = (len / (111111 * cosLat)) * Math.sin(toDir);

    const start = Cesium.Cartesian3.fromDegrees(lng, lat, 15000);
    const end   = Cesium.Cartesian3.fromDegrees(
      Math.max(-180, Math.min(180, lng + dLng)),
      Math.max(-85,  Math.min(85,  lat + dLat)),
      15000
    );

    windEntities.push(viewer.entities.add({
      polyline: {
        positions: [start, end],
        width:     3,
        material:  new Cesium.PolylineArrowMaterialProperty(windColor(speed).withAlpha(0.72)),
      },
    }));
  }
}

async function cargarVientos() {
  const statusEl = document.getElementById('wind-status');
  statusEl.textContent = 'Cargando...';

  const lats = WIND_GRID.map(p => p.lat).join(',');
  const lngs = WIND_GRID.map(p => p.lng).join(',');

  try {
    const res  = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lngs}` +
      `&current=wind_speed_10m,wind_direction_10m`
    );
    const data = await res.json();
    const arr  = Array.isArray(data) ? data : [data];

    createWindArrows(arr.map((d, i) => ({
      lat:       WIND_GRID[i].lat,
      lng:       WIND_GRID[i].lng,
      speed:     d.current?.wind_speed_10m     ?? 0,
      direction: d.current?.wind_direction_10m ?? 0,
    })));

    statusEl.textContent = `Activo · ${arr.length} puntos`;
  } catch (e) {
    statusEl.textContent = 'Error al cargar';
  }
}

// ── Incendios Córdoba · NASA FIRMS ──────────────────────────────────────────
// Focos de calor activos (VIIRS 375 m) casi en tiempo real.
// 1) Conseguí tu map key GRATIS en: https://firms.modaps.eosdis.nasa.gov/api/map_key/
// 2) Pegala abajo reemplazando 'TU_MAP_KEY_ACA'.
const FIRMS_MAP_KEY = 'bea2d4de74297107f7358cf27fc436 5b';
const FIRMS_SOURCE  = 'VIIRS_SNPP_NRT';        // sensor VIIRS Suomi-NPP (tiempo casi real)
const FIRMS_AREA    = '-66,-35.2,-61.5,-29.4'; // Córdoba: oeste,sur,este,norte
const FIRMS_DAYS    = 3;                        // últimos N días (máx 10)

const fireEntities = [];

function fireColor(frp) {
  // FRP = Fire Radiative Power (MW): cuanto más alto, más intenso el foco.
  if (frp <  5) return Cesium.Color.fromCssColorString('#ffdd00');
  if (frp < 20) return Cesium.Color.fromCssColorString('#ff9900');
  if (frp < 50) return Cesium.Color.fromCssColorString('#ff5500');
  return Cesium.Color.fromCssColorString('#ff1111');
}

function clearFireEntities() {
  for (const e of fireEntities) viewer.entities.remove(e);
  fireEntities.length = 0;
}

// Parser CSV mínimo de FIRMS: usa la fila de encabezado para mapear columnas.
function parseFirmsCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const head = lines[0].split(',').map(s => s.trim());
  const iLat  = head.indexOf('latitude');
  const iLng  = head.indexOf('longitude');
  const iFrp  = head.indexOf('frp');
  const iConf = head.indexOf('confidence');
  const iDate = head.indexOf('acq_date');
  const iTime = head.indexOf('acq_time');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const lat = parseFloat(c[iLat]), lng = parseFloat(c[iLng]);
    if (isNaN(lat) || isNaN(lng)) continue;
    out.push({
      lat, lng,
      frp:        iFrp  >= 0 ? parseFloat(c[iFrp]) || 0 : 0,
      confidence: iConf >= 0 ? c[iConf] : '—',
      fecha:      iDate >= 0 ? c[iDate] : '',
      hora:       iTime >= 0 ? c[iTime] : '',
    });
  }
  return out;
}

function createFireMarkers(data) {
  clearFireEntities();
  for (const f of data) {
    const color  = fireColor(f.frp);
    const entity = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(f.lng, f.lat, 6000),
      point: {
        pixelSize:    Math.max(5, Math.min(18, 5 + Math.sqrt(f.frp) * 1.5)),
        color:        color.withAlpha(0.85),
        outlineColor: Cesium.Color.fromCssColorString('#000805').withAlpha(0.5),
        outlineWidth: 1,
      },
    });
    entity._fire = f;
    fireEntities.push(entity);
  }
}

async function cargarIncendios() {
  const statusEl = document.getElementById('fire-status');
  if (FIRMS_MAP_KEY === 'TU_MAP_KEY_ACA') {
    statusEl.textContent = 'Falta map key (ver planeta.js)';
    return;
  }
  statusEl.textContent = 'Cargando...';
  try {
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/` +
                `${FIRMS_MAP_KEY}/${FIRMS_SOURCE}/${FIRMS_AREA}/${FIRMS_DAYS}`;
    const res  = await fetch(url);
    const text = await res.text();
    const data = parseFirmsCSV(text);
    createFireMarkers(data);
    statusEl.textContent = data.length
      ? `Activo · ${data.length} focos · últimos ${FIRMS_DAYS}d`
      : `Sin focos en los últimos ${FIRMS_DAYS}d`;
  } catch (e) {
    statusEl.textContent = 'Error al cargar';
  }
}

// ── Riesgo Sísmico ────────────────────────────────────────────────────────────
const riskEntities = [];

function clearRiskEntities() {
  for (const e of riskEntities) viewer.entities.remove(e);
  riskEntities.length = 0;
}

const CELL = 5; // degrees, matches computeRiskFromMarkers

function renderRiskZones(predictions) {
  clearRiskEntities();
  for (const { lat, lng, risk, count, maxMag } of predictions) {
    if (risk < 0.35) continue;
    const color  = riskColor(risk);
    const entity = viewer.entities.add({
      rectangle: {
        coordinates: Cesium.Rectangle.fromDegrees(
          lng - CELL / 2,
          lat - CELL / 2,
          lng + CELL / 2,
          lat + CELL / 2
        ),
        material:     color.withAlpha(0.12 + risk * 0.25),
        height:       3000,
        outline:      true,
        outlineColor: color.withAlpha(0.6),
        outlineWidth: 1,
      },
    });
    entity._risk = { lat, lng, risk, count: count ?? '—', maxMag: maxMag ?? '—' };
    riskEntities.push(entity);
  }
}

// ETAS-based risk: Gutenberg-Richter + Omori-Utsu + Poisson
function computeSeismicRisk(quakes) {
  if (!quakes.length) return 0;
  const Mc = 2.5, TARGET_M = 5.0, DAYS = 7;
  const mags = quakes.map(q => q.mag).filter(m => m >= Mc);
  if (!mags.length) return 0;

  const meanMag = mags.reduce((a, b) => a + b, 0) / mags.length;
  const bval    = mags.length >= 5
    ? Math.log10(Math.E) / Math.max(0.01, meanMag - Mc + 0.05)
    : 1.0;
  const lambdaBg = mags.length / 30;

  const K = 0.08, alpha = 0.8, c = 0.001, p = 1.1;
  const now = Date.now();
  let lambdaOmori = 0;
  for (const q of quakes) {
    if (q.mag >= 4.0 && q.timestamp) {
      const t = Math.max(0, (now - q.timestamp) / 86400000);
      lambdaOmori += K * Math.pow(10, alpha * (q.mag - Mc)) / Math.pow(t + c, p);
    }
  }

  const expectedTotal  = (lambdaBg + lambdaOmori) * DAYS;
  const expectedAbove5 = expectedTotal * Math.pow(10, -bval * (TARGET_M - Mc));
  return Math.min(1, 1 - Math.exp(-Math.max(0, expectedAbove5)));
}

function computeRiskFromMarkers(markerList) {
  const cells = new Map();
  const now   = Date.now();
  const WINDOW_MS = 30 * 86400000;

  for (const m of markerList) {
    const { lat, lng, rawMag, timestamp } = m.userData;
    if (lat == null || (now - timestamp) > WINDOW_MS) continue;
    const lb  = Math.floor(lat / CELL) * CELL;
    const cb  = Math.floor(lng / CELL) * CELL;
    const key = `${lb}_${cb}`;
    if (!cells.has(key)) cells.set(key, { lat: lb + CELL / 2, lng: cb + CELL / 2, quakes: [] });
    cells.get(key).quakes.push({ mag: rawMag, timestamp });
  }

  const results = [];
  for (const cell of cells.values()) {
    const risk = computeSeismicRisk(cell.quakes);
    const mags = cell.quakes.map(q => q.mag);
    results.push({ lat: cell.lat, lng: cell.lng, risk, count: mags.length, maxMag: Math.max(...mags) });
  }
  return results.sort((a, b) => b.risk - a.risk);
}

function updateRiskPanel(predictions, source) {
  const statusEl = document.getElementById('risk-status');
  const topEl    = document.getElementById('risk-top-zones');
  const active   = predictions.filter(p => p.risk >= 0.05);
  statusEl.textContent = `${source} · ${active.length} zonas`;

  topEl.innerHTML = predictions.slice(0, 5).map(p => {
    const latS = `${Math.abs(p.lat).toFixed(1)}°${p.lat >= 0 ? 'N' : 'S'}`;
    const lngS = `${Math.abs(p.lng).toFixed(1)}°${p.lng >= 0 ? 'E' : 'O'}`;
    const pct  = (p.risk * 100).toFixed(0);
    const col  = p.risk < 0.3 ? '#66cc00' : p.risk < 0.6 ? '#ffdd00' : p.risk < 0.75 ? '#ff7700' : '#ff1111';
    return `<div class="risk-zone-row"><span>${latS} ${lngS}</span><span style="color:${col};font-weight:700">${pct}%</span></div>`;
  }).join('');
}

async function actualizarRiesgo() {
  const legendEl = document.getElementById('risk-legend');
  const topEl    = document.getElementById('risk-top-zones');
  legendEl.style.display = 'block';
  topEl.style.display    = 'block';
  document.getElementById('risk-status').textContent = 'Calculando…';

  try {
    const res = await fetch('seismic_predictions.json?t=' + Date.now());
    if (res.ok) {
      const data  = await res.json();
      renderRiskZones(data.predictions);
      updateRiskPanel(data.predictions, data.model === 'xgboost' ? `XGBoost AUC ${data.auc}` : 'ETAS estadístico');
      return;
    }
  } catch (_) {}

  const predictions = computeRiskFromMarkers(markers);
  renderRiskZones(predictions);
  updateRiskPanel(predictions, 'ETAS · tiempo real');
}

// ── Auto-rotación ─────────────────────────────────────────────────────────────
let rotacionPausada = false;
let _interactTimer  = null;
let isInteracting   = false;

function _onInteract() {
  isInteracting = true;
  clearTimeout(_interactTimer);
  _interactTimer = setTimeout(() => { isInteracting = false; }, 400);
}

viewer.scene.canvas.addEventListener('mousedown', _onInteract);
viewer.scene.canvas.addEventListener('wheel',     _onInteract, { passive: true });
window.addEventListener('touchstart', _onInteract, { passive: true });

// camera.rotate(UNIT_Z, angle) orbits around the pole axis without resetting
// Cesium's internal camera controller state — so zoom/pan still work correctly.
viewer.scene.postRender.addEventListener(() => {
  // HUD altitude
  const alt = viewer.camera.positionCartographic.height;
  const hud = document.getElementById('hud-readout');
  hud.textContent = alt < 4000000
    ? `SEISMIC ARRAY · ALT ${(alt / 1000).toFixed(0)} KM`
    : 'SEISMIC ARRAY · USGS · OPEN-METEO · EN LÍNEA';

  if (rotacionPausada || isInteracting) return;
  viewer.camera.rotate(Cesium.Cartesian3.UNIT_Z, -0.0001);
});

// ── Botón pausa ───────────────────────────────────────────────────────────────
const pauseBtn = document.getElementById('pause-btn');
pauseBtn.addEventListener('click', () => {
  rotacionPausada = !rotacionPausada;
  pauseBtn.textContent = rotacionPausada ? '▶' : '⏸';
  pauseBtn.title = rotacionPausada ? 'Reanudar rotación' : 'Pausar rotación';
});

// ── Controles del panel ───────────────────────────────────────────────────────
const panelEl = document.getElementById('panel');
document.getElementById('panel-toggle').addEventListener('click', () => panelEl.classList.add('hidden'));
document.getElementById('panel-open').addEventListener('click',   () => panelEl.classList.remove('hidden'));
document.getElementById('panel-btn-mob').addEventListener('click', () => panelEl.classList.toggle('hidden'));

const magSlider = document.getElementById('mag-min');
const magVal    = document.getElementById('mag-val');
magSlider.addEventListener('input', () => {
  magVal.textContent   = magSlider.value;
  currentParams.minMag = parseFloat(magSlider.value);
});

document.querySelectorAll('.period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const v = btn.dataset.days;
    const customDates = document.getElementById('custom-dates');
    if (v === 'custom') {
      customDates.style.display = 'flex';
      currentParams.days = null;
    } else {
      customDates.style.display = 'none';
      currentParams.days     = parseInt(v);
      currentParams.dateFrom = null;
      currentParams.dateTo   = null;
    }
  });
});

const hoy  = new Date();
const hace7 = new Date(hoy); hace7.setDate(hoy.getDate() - 7);
document.getElementById('date-to').value   = hoy.toISOString().split('T')[0];
document.getElementById('date-from').value = hace7.toISOString().split('T')[0];

document.getElementById('date-from').addEventListener('change', e => { currentParams.dateFrom = e.target.value; });
document.getElementById('date-to').addEventListener('change',   e => { currentParams.dateTo   = e.target.value; });
document.getElementById('apply-btn').addEventListener('click',  () => cargarTerremotos(currentParams));

document.getElementById('alert-toggle').addEventListener('change', e => {
  const activo = e.target.checked;
  document.getElementById('alert-status').textContent = activo ? 'Activo — revisando cada 5 min' : 'Inactivo';
  if (activo) {
    if (Notification.permission === 'default') Notification.requestPermission();
    checkAlerts();
    alertTimer = setInterval(checkAlerts, 5 * 60 * 1000);
  } else {
    clearInterval(alertTimer);
    alertTimer = null;
  }
});

document.getElementById('alert-close').addEventListener('click', () => {
  document.getElementById('alert-notif').style.display = 'none';
});

document.getElementById('wind-toggle').addEventListener('change', e => {
  const legend = document.getElementById('wind-legend');
  if (e.target.checked) {
    legend.style.display = 'block';
    cargarVientos();
  } else {
    legend.style.display = 'none';
    clearWindEntities();
    document.getElementById('wind-status').textContent = 'Inactivo';
  }
});

document.getElementById('fire-toggle').addEventListener('change', e => {
  const legend = document.getElementById('fire-legend');
  if (e.target.checked) {
    legend.style.display = 'block';
    cargarIncendios();
  } else {
    legend.style.display = 'none';
    clearFireEntities();
    document.getElementById('fire-status').textContent = 'Inactivo';
  }
});

document.getElementById('risk-toggle').addEventListener('change', e => {
  const legendEl = document.getElementById('risk-legend');
  const topEl    = document.getElementById('risk-top-zones');
  if (e.target.checked) {
    actualizarRiesgo();
  } else {
    clearRiskEntities();
    legendEl.style.display = 'none';
    topEl.style.display    = 'none';
    document.getElementById('risk-status').textContent = 'Inactivo';
  }
});

// ── Botones de zoom ───────────────────────────────────────────────────────────
document.getElementById('zoom-in').addEventListener('click', () => {
  const h = viewer.camera.positionCartographic.height;
  viewer.camera.zoomIn(h * 0.4);
});
document.getElementById('zoom-out').addEventListener('click', () => {
  const h = viewer.camera.positionCartographic.height;
  viewer.camera.zoomOut(h * 0.6);
});

// ── Init ──────────────────────────────────────────────────────────────────────
cargarTerremotos(currentParams);
