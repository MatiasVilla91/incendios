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
viewer.imageryLayers.removeAll();
Cesium.ArcGisMapServerImageryProvider.fromUrl(
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'
).then(p => viewer.imageryLayers.addImageryProvider(p));

viewer.scene.globe.enableLighting       = false;
viewer.scene.globe.showGroundAtmosphere = true;
viewer.scene.fog.enabled                = false;

// Initial camera — centrado en las Sierras de Córdoba
const CORDOBA = { lat: -31.4, lng: -64.5 };
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(CORDOBA.lng, CORDOBA.lat, 1300000),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
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

// ── Helpers de color ────────────────────────────────────────────────────────
function windColor(speed) {
  if (speed <  5) return Cesium.Color.fromCssColorString('#44ddff');
  if (speed < 10) return Cesium.Color.fromCssColorString('#88ffaa');
  if (speed < 20) return Cesium.Color.fromCssColorString('#ffdd00');
  if (speed < 30) return Cesium.Color.fromCssColorString('#ff6600');
  return Cesium.Color.fromCssColorString('#ff2222');
}

function fireColor(frp) {
  // FRP = Fire Radiative Power (MW): cuanto más alto, más intenso el foco.
  if (frp <  5) return Cesium.Color.fromCssColorString('#ffdd00');
  if (frp < 20) return Cesium.Color.fromCssColorString('#ff9900');
  if (frp < 50) return Cesium.Color.fromCssColorString('#ff5500');
  return Cesium.Color.fromCssColorString('#ff1111');
}

// ── Vientos (contexto de propagación del fuego) ─────────────────────────────
// Grilla densa sobre Argentina central / Córdoba.
const WIND_GRID = (() => {
  const pts = [];
  for (let lat = -36; lat <= -28; lat += 1.5)
    for (let lng = -67; lng <= -61; lng += 1.5)
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

    const len    = Math.min(180000, Math.max(40000, speed * 6000));
    const toDir  = ((direction + 180) % 360) * Math.PI / 180;
    const dLat   = (len / 111111) * Math.cos(toDir);
    const cosLat = Math.cos(lat * Math.PI / 180) || 0.001;
    const dLng   = (len / (111111 * cosLat)) * Math.sin(toDir);

    const start = Cesium.Cartesian3.fromDegrees(lng, lat, 15000);
    const end   = Cesium.Cartesian3.fromDegrees(lng + dLng, lat + dLat, 15000);

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
// Conseguí tu map key gratis en: https://firms.modaps.eosdis.nasa.gov/api/map_key/
const FIRMS_MAP_KEY = 'bea2d4de74297107f7358cf27fc4365b';
const FIRMS_SOURCE  = 'VIIRS_SNPP_NRT';        // sensor VIIRS Suomi-NPP (tiempo casi real)
const FIRMS_AREA    = '-66,-35.2,-61.5,-29.4'; // Córdoba: oeste,sur,este,norte
let   FIRMS_DAYS    = 3;                        // últimos N días (máx 10) — lo cambian los botones

// La API de FIRMS no envía cabeceras CORS, así que el navegador bloquea la
// llamada directa. Ruteamos por un proxy CORS público (probamos varios por si
// alguno está caído). Para producción conviene cachear FIRMS en un JSON propio.
const CORS_PROXIES = [
  u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  u => `https://thingproxy.freeboard.io/fetch/${u}`,
];

const fireEntities = [];

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

// Intenta la URL de FIRMS a través de los proxies CORS, en orden, hasta que uno
// devuelva una respuesta válida (CSV, no una página de error del proxy).
async function fetchFirmsText(firmsUrl) {
  let lastErr = null;
  for (const wrap of CORS_PROXIES) {
    try {
      const res = await fetch(wrap(firmsUrl));
      if (!res.ok) { lastErr = new Error('HTTP ' + res.status); continue; }
      const text = await res.text();
      // Una respuesta válida es CSV (encabezado con 'latitude') o vacía.
      if (text.includes('latitude') || text.trim() === '' || text.startsWith('Invalid')) {
        return text;
      }
      lastErr = new Error('respuesta no-CSV del proxy');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('todos los proxies fallaron');
}

async function cargarIncendios() {
  const statusEl = document.getElementById('fire-status');
  if (!FIRMS_MAP_KEY || FIRMS_MAP_KEY === 'TU_MAP_KEY_ACA') {
    statusEl.textContent = 'Falta map key (ver planeta.js)';
    return;
  }
  statusEl.textContent = 'Cargando…';
  const firmsUrl = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/` +
                   `${FIRMS_MAP_KEY}/${FIRMS_SOURCE}/${FIRMS_AREA}/${FIRMS_DAYS}`;
  try {
    const text = await fetchFirmsText(firmsUrl);
    if (text.startsWith('Invalid')) {
      clearFireEntities();
      statusEl.textContent = 'Map key inválida';
      return;
    }
    const data = parseFirmsCSV(text);
    createFireMarkers(data);
    statusEl.textContent = data.length
      ? `Activo · ${data.length} focos · últimos ${FIRMS_DAYS}d`
      : `Sin focos en los últimos ${FIRMS_DAYS}d (invierno: temporada baja)`;
  } catch (e) {
    statusEl.textContent = 'Error de red/proxy — reintentá';
  }
}

// ── Tooltip de foco (hover + tap) ───────────────────────────────────────────
const infoEl     = document.getElementById('fire-info');
const scarInfoEl = document.getElementById('scar-info');
const deptInfoEl = document.getElementById('dept-info');
let   scarDataSource  = null;
let   currentScarYear = 2024;
const deptHoverMap    = new Map(); // entity.id → nombre del departamento

function fireTooltipHTML(f) {
  const latS = `${Math.abs(f.lat).toFixed(3)}°${f.lat >= 0 ? 'N' : 'S'}`;
  const lngS = `${Math.abs(f.lng).toFixed(3)}°${f.lng >= 0 ? 'E' : 'O'}`;
  const hhmm = f.hora ? String(f.hora).padStart(4, '0').replace(/(\d{2})(\d{2})/, '$1:$2') : '';
  return `<strong>🔥 Foco activo · ${f.frp.toFixed(1)} MW</strong>` +
         `<br><small>${f.fecha} ${hhmm} UTC · confianza ${f.confidence}` +
         `<br>${latS}  ${lngS}</small>`;
}

function showFireTooltip(picked, x, y) {
  if (Cesium.defined(picked) && picked.id && picked.id._fire) {
    infoEl.innerHTML     = fireTooltipHTML(picked.id._fire);
    infoEl.style.display = 'block';
    infoEl.style.left    = x + 'px';
    infoEl.style.top     = y + 'px';
    viewer.scene.canvas.style.cursor = 'crosshair';
    return true;
  }
  infoEl.style.display = 'none';
  viewer.scene.canvas.style.cursor = '';
  return false;
}

const hoverHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
hoverHandler.setInputAction((m) => {
  const picked = viewer.scene.pick(m.endPosition);
  const x = m.endPosition.x + 14;
  const y = m.endPosition.y - 10;

  if (showFireTooltip(picked, x, y)) {
    deptInfoEl.style.display = 'none';
    return;
  }

  if (Cesium.defined(picked) && picked.id && scarDataSource &&
      scarDataSource.entities.contains(picked.id)) {
    viewer.scene.canvas.style.cursor = 'pointer';
    infoEl.style.display = 'none';
    deptInfoEl.style.display = 'none';
    return;
  }

  // Hover sobre departamento
  const entityId = picked?.id?.id;
  if (entityId && deptHoverMap.has(entityId)) {
    const nombre = deptHoverMap.get(entityId);
    deptInfoEl.textContent = nombre;
    deptInfoEl.style.display = 'block';
    deptInfoEl.style.left = x + 'px';
    deptInfoEl.style.top  = y + 'px';
    viewer.scene.canvas.style.cursor = 'default';
  } else {
    deptInfoEl.style.display = 'none';
    viewer.scene.canvas.style.cursor = '';
  }
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

const tapHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
tapHandler.setInputAction((click) => {
  const picked = viewer.scene.pick(click.position);
  const x = Math.min(click.position.x + 16, window.innerWidth - 240);
  const y = Math.max(click.position.y - 16, 10);
  if (!showFireTooltip(picked, x, y)) {
    showScarTooltip(picked, x, y);
  } else {
    scarInfoEl.style.display = 'none';
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// ── Auto-rotación (arranca pausada para mantener Córdoba a la vista) ─────────
let rotacionPausada = true;
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

viewer.scene.postRender.addEventListener(() => {
  const alt = viewer.camera.positionCartographic.height;
  const hud = document.getElementById('hud-readout');
  hud.textContent = alt < 4000000
    ? `INCENDIOS CÓRDOBA · ALT ${(alt / 1000).toFixed(0)} KM`
    : 'INCENDIOS CÓRDOBA · NASA FIRMS · OPEN-METEO · EN LÍNEA';

  if (rotacionPausada || isInteracting) return;
  viewer.camera.rotate(Cesium.Cartesian3.UNIT_Z, -0.0001);
});

// ── Botón pausa ───────────────────────────────────────────────────────────────
const pauseBtn = document.getElementById('pause-btn');
pauseBtn.textContent = rotacionPausada ? '▶' : '⏸';
pauseBtn.title       = rotacionPausada ? 'Reanudar rotación' : 'Pausar rotación';
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

// Selector de rango de días para incendios
document.querySelectorAll('.period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    FIRMS_DAYS = parseInt(btn.dataset.days);
    if (document.getElementById('fire-toggle').checked) cargarIncendios();
  });
});

// Botón "centrar en Córdoba"
document.getElementById('center-btn')?.addEventListener('click', () => {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(CORDOBA.lng, CORDOBA.lat, 1300000),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    duration: 1.5,
  });
});

// Toggle vientos
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

// Toggle incendios
document.getElementById('fire-toggle').addEventListener('change', e => {
  const legend = document.getElementById('fire-legend');
  if (e.target.checked) {
    legend.style.display = 'block';
    cargarIncendios();
  } else {
    legend.style.display = 'none';
    clearFireEntities();
    infoEl.style.display = 'none';
    document.getElementById('fire-status').textContent = 'Inactivo';
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

// ── Esri Wayback · comparador de imágenes históricas ──────────────────────
const WAYBACK_CONFIG_URL = 'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json';

let waybackReleases   = [];
let waybackLayerLeft  = null;
let waybackLayerRight = null;
let waybackActive     = false;
let arrastrando       = false;

const splitLineEl = document.getElementById('split-line');

function waybackTileUrl(num) {
  return `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${num}/{z}/{y}/{x}`;
}

function posicionarDivisor(frac) {
  splitLineEl.style.left = (frac * 100) + '%';
}

function clearWaybackLayers() {
  if (waybackLayerLeft)  { viewer.imageryLayers.remove(waybackLayerLeft,  true); waybackLayerLeft  = null; }
  if (waybackLayerRight) { viewer.imageryLayers.remove(waybackLayerRight, true); waybackLayerRight = null; }
}

async function fetchWaybackReleases() {
  const res  = await fetch(WAYBACK_CONFIG_URL);
  const json = await res.json();
  const list = Object.entries(json).map(([num, r]) => {
    const m    = (r.itemTitle || '').match(/(\d{4}-\d{2}-\d{2})/);
    const date = m ? m[1] : null;
    return { num, date, ts: date ? new Date(date).getTime() : NaN };
  }).filter(r => !isNaN(r.ts));
  list.sort((a, b) => a.ts - b.ts);
  return list;
}

function poblarSelectores() {
  const leftEl  = document.getElementById('wayback-left');
  const rightEl = document.getElementById('wayback-right');
  leftEl.innerHTML  = '';
  rightEl.innerHTML = '';

  for (const r of waybackReleases) {
    const makeOpt = () => Object.assign(document.createElement('option'), { value: r.num, textContent: r.date });
    leftEl.appendChild(makeOpt());
    rightEl.appendChild(makeOpt());
  }

  // Default: izquierda ≈ 2016, derecha = más reciente
  const idx = waybackReleases.findIndex(r => r.ts >= new Date('2016-01-01').getTime());
  leftEl.selectedIndex  = idx >= 0 ? idx : 0;
  rightEl.selectedIndex = waybackReleases.length - 1;
}

async function aplicarWayback() {
  const statusEl = document.getElementById('wayback-status');
  clearWaybackLayers();

  const leftNum  = document.getElementById('wayback-left').value;
  const rightNum = document.getElementById('wayback-right').value;

  const makeProvider = num => new Cesium.UrlTemplateImageryProvider({
    url:          waybackTileUrl(num),
    maximumLevel: 23,
    credit:       'Esri World Imagery Wayback',
  });

  waybackLayerLeft  = viewer.imageryLayers.addImageryProvider(makeProvider(leftNum));
  waybackLayerRight = viewer.imageryLayers.addImageryProvider(makeProvider(rightNum));

  waybackLayerLeft.splitDirection  = Cesium.SplitDirection.LEFT;
  waybackLayerRight.splitDirection = Cesium.SplitDirection.RIGHT;

  viewer.scene.splitPosition = 0.5;
  posicionarDivisor(0.5);

  const dateL = waybackReleases.find(r => r.num === leftNum)?.date  || '?';
  const dateR = waybackReleases.find(r => r.num === rightNum)?.date || '?';
  statusEl.textContent = `${dateL} ↔ ${dateR}`;
}

async function activarWayback() {
  const statusEl = document.getElementById('wayback-status');

  if (!waybackReleases.length) {
    statusEl.textContent = 'Cargando fechas…';
    try {
      waybackReleases = await fetchWaybackReleases();
      poblarSelectores();
    } catch {
      statusEl.textContent = 'Error al cargar Wayback';
      document.getElementById('wayback-toggle').checked = false;
      return;
    }
  }

  document.getElementById('wayback-controls').style.display = 'flex';
  splitLineEl.style.display = 'block';
  waybackActive = true;
  await aplicarWayback();
}

function desactivarWayback() {
  clearWaybackLayers();
  splitLineEl.style.display = 'none';
  document.getElementById('wayback-controls').style.display = 'none';
  document.getElementById('wayback-status').textContent = 'Inactivo';
  viewer.scene.splitPosition = 0;
  waybackActive = false;
}

// Drag del divisor (mouse + touch)
function onDragSplit(clientX) {
  const frac = Math.max(0.02, Math.min(0.98, clientX / window.innerWidth));
  viewer.scene.splitPosition = frac;
  posicionarDivisor(frac);
}

splitLineEl.addEventListener('mousedown',  e => { arrastrando = true;  e.preventDefault(); });
splitLineEl.addEventListener('touchstart', e => { arrastrando = true;  e.preventDefault(); }, { passive: false });
window.addEventListener('mousemove',  e => { if (arrastrando) onDragSplit(e.clientX); });
window.addEventListener('mouseup',    () => { arrastrando = false; });
window.addEventListener('touchmove',  e => {
  if (arrastrando) { onDragSplit(e.touches[0].clientX); e.preventDefault(); }
}, { passive: false });
window.addEventListener('touchend', () => { arrastrando = false; });

document.getElementById('wayback-toggle').addEventListener('change', e => {
  if (e.target.checked) activarWayback();
  else desactivarWayback();
});

['wayback-left', 'wayback-right'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    if (waybackActive) aplicarWayback();
  });
});

// ── Cicatrices históricas (GEE · Sentinel-2 · dNBR) ────────────────────────
function scarColor(sev) {
  if (sev <= 2) return Cesium.Color.fromCssColorString('#ff9900');
  if (sev === 3) return Cesium.Color.fromCssColorString('#ff5500');
  return Cesium.Color.fromCssColorString('#ff1111');
}

function clearCicatrices() {
  if (scarDataSource) {
    viewer.dataSources.remove(scarDataSource, true);
    scarDataSource = null;
  }
  scarInfoEl.style.display = 'none';
}

async function cargarCicatrices(year) {
  const statusEl = document.getElementById('scar-status');
  statusEl.textContent = 'Cargando...';
  clearCicatrices();
  try {
    const ds = await Cesium.GeoJsonDataSource.load(
      `data/incendios_${year}.geojson`,
      { clampToGround: true }
    );
    let count = 0, nBosque = 0, nIdecor = 0;
    for (const entity of ds.entities.values) {
      if (!entity.polygon) continue;
      const props     = entity.properties?.getValue(Cesium.JulianDate.now()) ?? {};
      const bosque    = !!props.bosque_nativo;
      const verificado = !!props.idecor_verificado;
      const alpha     = verificado ? 0.70 : 0.55;
      entity.polygon.material     = scarColor(props.severidad ?? 2).withAlpha(alpha);
      entity.polygon.outline      = bosque;
      entity.polygon.outlineColor = Cesium.Color.fromCssColorString('#00ff88').withAlpha(0.9);
      entity.polygon.outlineWidth = 2;
      count++;
      if (bosque)    nBosque++;
      if (verificado) nIdecor++;
    }
    viewer.dataSources.add(ds);
    scarDataSource  = ds;
    currentScarYear = year;
    const bosqueNote = nBosque > 0 ? ` · ${nBosque} bosque nativo` : '';
    statusEl.textContent = `Activo · ${count} polígonos · ${year}${bosqueNote}`;
  } catch (e) {
    statusEl.textContent = 'Error al cargar';
    console.error('cicatrices:', e);
  }
}

function showScarTooltip(picked, x, y) {
  if (!Cesium.defined(picked) || !picked.id || !scarDataSource ||
      !scarDataSource.entities.contains(picked.id)) {
    scarInfoEl.style.display = 'none';
    return false;
  }
  const props      = picked.id.properties?.getValue(Cesium.JulianDate.now()) ?? {};
  const sev        = props.severidad ?? 2;
  const label      = (props.severidad_label ?? '').replace(/_/g, '-');
  const area       = props.area_ha ?? 0;
  const yr         = props.year ?? currentScarYear;
  const cols       = { 2: '#ff9900', 3: '#ff5500', 4: '#ff1111' };
  const col        = cols[sev] || '#ff9900';
  const bosque     = !!props.bosque_nativo;
  const verificado = !!props.idecor_verificado;
  const cobertura  = props.coberturas_idecor || '';
  const localidad  = props.localidad_idecor  || '';

  let html = `<strong style="color:${col}">Cicatriz &middot; ${yr}</strong>`;
  if (bosque)
    html += `<br><span style="color:#00ff88;font-weight:bold">&#x25CF; Bosque nativo quemado</span>`;
  html += `<br><small>Severidad: ${label} (clase ${sev})<br>&Aacute;rea: ~${area} ha</small>`;
  if (verificado) {
    html += `<br><small style="color:#aaffcc">&#x2713; IDECOR verificado`;
    if (localidad) html += ` &middot; ${localidad}`;
    html += `</small>`;
    if (cobertura)
      html += `<br><small style="color:#cccccc">Cobertura: ${cobertura}</small>`;
  }

  scarInfoEl.innerHTML = html;
  scarInfoEl.style.display = 'block';
  scarInfoEl.style.left    = x + 'px';
  scarInfoEl.style.top     = y + 'px';
  viewer.scene.canvas.style.cursor = 'crosshair';
  return true;
}

// ── Bosque nativo · WMS IDECOR ──────────────────────────────────────────────
let otbnLayer = null;

function cargarBosqueNativo() {
  if (otbnLayer) return;
  const provider = new Cesium.WebMapServiceImageryProvider({
    url:    'https://idecor-ws.mapascordoba.gob.ar/geoserver/idecor/wms',
    layers: 'idecor:mcv_ambiente_2023_2024_vectorizado',
    parameters: {
      format:      'image/png',
      transparent: 'true',
      CQL_FILTER:  "categoria LIKE 'Bosque%' OR categoria LIKE 'Matorral%'",
    },
  });
  otbnLayer = viewer.imageryLayers.addImageryProvider(provider);
  otbnLayer.alpha = 0.6;
  document.getElementById('otbn-status').textContent  = 'Activo · IDECOR 2023/24';
  document.getElementById('otbn-legend').style.display = 'block';
}

function limpiarBosqueNativo() {
  if (otbnLayer) {
    viewer.imageryLayers.remove(otbnLayer, true);
    otbnLayer = null;
  }
  document.getElementById('otbn-status').textContent  = 'Inactivo';
  document.getElementById('otbn-legend').style.display = 'none';
}

document.getElementById('otbn-toggle').addEventListener('change', e => {
  if (e.target.checked) cargarBosqueNativo();
  else limpiarBosqueNativo();
});

document.getElementById('scar-toggle').addEventListener('change', e => {
  const controls = document.getElementById('scar-controls');
  if (e.target.checked) {
    controls.style.display = 'block';
    cargarCicatrices(parseInt(document.getElementById('scar-year').value));
  } else {
    controls.style.display = 'none';
    clearCicatrices();
    document.getElementById('scar-status').textContent = 'Inactivo';
  }
});

document.getElementById('scar-year').addEventListener('change', e => {
  if (document.getElementById('scar-toggle').checked) {
    cargarCicatrices(parseInt(e.target.value));
  }
});

// ── División política · IGN (provincias) + IDECOR (departamentos Córdoba) ──
let divPolProvLayer  = null;
let divPolDeptSource = null;

async function cargarDivisionPolitica() {
  const statusEl = document.getElementById('divpol-status');
  statusEl.textContent = 'Cargando...';

  // 1. Provincias argentinas — WMS IGN (tile, sin CORS)
  divPolProvLayer = viewer.imageryLayers.addImageryProvider(
    new Cesium.WebMapServiceImageryProvider({
      url:    'https://wms.ign.gob.ar/geoserver/ign/wms',
      layers: 'provincia',
      parameters: { format: 'image/png', transparent: 'true' },
    })
  );
  divPolProvLayer.alpha = 0.75;

  // 2. Departamentos de Córdoba — polylines (visibles) + polígonos invisibles (hover)
  try {
    const resp   = await fetch('data/departamentos_cordoba.geojson');
    const geojson = await resp.json();
    const deptDS  = new Cesium.CustomDataSource('departamentos');
    deptHoverMap.clear();

    for (const feat of geojson.features) {
      const nombre = feat.properties?.nombre ?? '';
      const geom   = feat.geometry;
      const isMulti = geom.type === 'MultiPolygon';
      const polys   = isMulti ? geom.coordinates : [geom.coordinates];

      for (const poly of polys) {
        // Polyline visible por cada anillo
        for (const ring of poly) {
          const flat = ring.flatMap(([lon, lat]) => [lon, lat]);
          deptDS.entities.add({
            polyline: {
              positions:     Cesium.Cartesian3.fromDegreesArray(flat),
              width:         1.5,
              material:      Cesium.Color.WHITE.withAlpha(0.65),
              clampToGround: true,
            },
          });
        }

        // Polígono invisible para pick (outer ring solamente)
        if (nombre) {
          const outerFlat = poly[0].flatMap(([lon, lat]) => [lon, lat]);
          const e = deptDS.entities.add({
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(
                Cesium.Cartesian3.fromDegreesArray(outerFlat)
              ),
              material: Cesium.Color.WHITE.withAlpha(0.01),
              height:   0,
            },
          });
          deptHoverMap.set(e.id, nombre);
        }
      }
    }

    viewer.dataSources.add(deptDS);
    divPolDeptSource = deptDS;
    statusEl.textContent = 'Activo · provincias + 26 departamentos';
  } catch (e) {
    console.error('divpol dept:', e);
    statusEl.textContent = 'Activo · provincias cargadas';
  }
}

function limpiarDivisionPolitica() {
  if (divPolProvLayer) {
    viewer.imageryLayers.remove(divPolProvLayer, true);
    divPolProvLayer = null;
  }
  if (divPolDeptSource) {
    viewer.dataSources.remove(divPolDeptSource, true);
    divPolDeptSource = null;
  }
  deptHoverMap.clear();
  deptInfoEl.style.display = 'none';
  document.getElementById('divpol-status').textContent = 'Inactivo';
}

document.getElementById('divpol-toggle').addEventListener('change', e => {
  if (e.target.checked) cargarDivisionPolitica();
  else limpiarDivisionPolitica();
});

// ── Init: incendios activos al arrancar ────────────────────────────────────
document.getElementById('fire-toggle').checked = true;
document.getElementById('fire-legend').style.display = 'block';
cargarIncendios();
