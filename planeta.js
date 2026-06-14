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
let   _currentScarData = null;
const deptHoverMap    = new Map(); // entity.id → nombre del departamento
const loteoInfoEl     = document.getElementById('loteo-info');
let   loteosDataSource = null;
const loteoInfoMap    = new Map(); // entity.id → { nombre, titular, tipo, label }

const osmInfoEl          = document.getElementById('osm-info');
let   osmDataSource      = null;
const osmInfoMap         = new Map(); // entity.id → { tipo_label, nombre }

const recurrenciaInfoEl  = document.getElementById('recurrencia-info');
let   recurrenciaDS      = null;
const recurrenciaMap     = new Map(); // entity.id → { veces, area_ha }

function osmColor(tipo) {
  if (tipo === 'golf_course' || tipo === 'resort' || tipo === 'hotel')
    return Cesium.Color.fromCssColorString('#a855f7'); // violeta medio
  if (tipo === 'commercial' || tipo === 'industrial')
    return Cesium.Color.fromCssColorString('#7c3aed'); // violeta oscuro
  return Cesium.Color.fromCssColorString('#c084fc');   // violeta claro (residential, etc.)
}

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
  const allPicked = viewer.scene.drillPick(m.endPosition, 8);
  const x = m.endPosition.x + 14;
  const y = m.endPosition.y - 10;

  const firePick = allPicked.find(p => p?.id?._fire);
  if (showFireTooltip(firePick, x, y)) {
    deptInfoEl.style.display = 'none';
    return;
  }

  const scarPick = allPicked.find(p => p?.id && scarDataSource?.entities.contains(p.id));
  if (scarPick) {
    viewer.scene.canvas.style.cursor = 'pointer';
    infoEl.style.display     = 'none';
    deptInfoEl.style.display = 'none';
    recurrenciaInfoEl.style.display = 'none';
    return;
  }

  const recurrenciaPick = allPicked.find(p => p?.id?.id && recurrenciaMap.has(p.id.id));
  if (recurrenciaPick) {
    const rd = recurrenciaMap.get(recurrenciaPick.id.id);
    recurrenciaInfoEl.innerHTML =
      `<strong style="color:${recurrenciaColor(rd.veces)}">&#128293; Zona de alta recurrencia</strong>` +
      `<br><small>Quemada <strong>${rd.veces} veces</strong> entre 2018–2025<br>~${rd.area_ha} ha</small>`;
    recurrenciaInfoEl.style.display = 'block';
    recurrenciaInfoEl.style.left = x + 'px';
    recurrenciaInfoEl.style.top  = y + 'px';
    viewer.scene.canvas.style.cursor = 'pointer';
    infoEl.style.display     = 'none';
    deptInfoEl.style.display = 'none';
    return;
  }
  recurrenciaInfoEl.style.display = 'none';

  const osmPick   = allPicked.find(p => p?.id?.id && osmInfoMap.has(p.id.id));
  const loteoPick = allPicked.find(p => p?.id?.id && loteoInfoMap.has(p.id.id));
  const deptPick  = allPicked.find(p => p?.id?.id && deptHoverMap.has(p.id.id));

  // Hover sobre feature OSM
  if (osmPick) {
    viewer.scene.canvas.style.cursor = 'pointer';
    infoEl.style.display     = 'none';
    deptInfoEl.style.display = 'none';
    return;
  }

  // Hover sobre loteo
  if (loteoPick) {
    viewer.scene.canvas.style.cursor = 'pointer';
    infoEl.style.display     = 'none';
    deptInfoEl.style.display = 'none';
    return;
  }

  // Hover sobre departamento
  if (deptPick) {
    const nombre = deptHoverMap.get(deptPick.id.id);
    deptInfoEl.textContent   = nombre;
    deptInfoEl.style.display = 'block';
    deptInfoEl.style.left    = x + 'px';
    deptInfoEl.style.top     = y + 'px';
    viewer.scene.canvas.style.cursor = 'default';
  } else {
    deptInfoEl.style.display = 'none';
    viewer.scene.canvas.style.cursor = '';
  }
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

const tapHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
tapHandler.setInputAction((click) => {
  const allPicked = viewer.scene.drillPick(click.position, 10);
  const x = Math.min(click.position.x + 16, window.innerWidth - 240);
  const y = Math.max(click.position.y - 16, 10);

  const firePick        = allPicked.find(p => p?.id?._fire);
  const scarPick        = allPicked.find(p => p?.id && scarDataSource?.entities.contains(p.id));
  const loteoPick       = allPicked.find(p => p?.id?.id && loteoInfoMap.has(p.id.id));
  const osmPick         = allPicked.find(p => p?.id?.id && osmInfoMap.has(p.id.id));
  const recurrenciaPick2 = allPicked.find(p => p?.id?.id && recurrenciaMap.has(p.id.id));

  if (showFireTooltip(firePick, x, y)) {
    scarInfoEl.style.display       = 'none';
    loteoInfoEl.style.display      = 'none';
    osmInfoEl.style.display        = 'none';
    recurrenciaInfoEl.style.display = 'none';
  } else if (showScarTooltip(scarPick, x, y)) {
    loteoInfoEl.style.display       = 'none';
    osmInfoEl.style.display         = 'none';
    recurrenciaInfoEl.style.display = 'none';
    if (_currentScarData && recurrenciaPick2) {
      const rd = recurrenciaMap.get(recurrenciaPick2.id.id);
      if (rd) _currentScarData.veces_quemado = rd.veces;
    }
  } else if (showLoteoTooltip(loteoPick, x, y)) {
    scarInfoEl.style.display       = 'none';
    osmInfoEl.style.display        = 'none';
    recurrenciaInfoEl.style.display = 'none';
  } else if (recurrenciaPick2) {
    scarInfoEl.style.display  = 'none';
    loteoInfoEl.style.display = 'none';
    osmInfoEl.style.display   = 'none';
  } else {
    scarInfoEl.style.display       = 'none';
    loteoInfoEl.style.display      = 'none';
    recurrenciaInfoEl.style.display = 'none';
    showOSMTooltip(osmPick ?? allPicked[0], x, y);
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
    let count = 0, nBosque = 0, nIdecor = 0, totalHa = 0, nLoteo = 0;
    for (const entity of ds.entities.values) {
      if (!entity.polygon) continue;
      const props      = entity.properties?.getValue(Cesium.JulianDate.now()) ?? {};
      const bosque     = !!props.bosque_nativo;
      const verificado = !!props.idecor_verificado;
      const alpha      = verificado ? 0.45 : 0.30;
      entity.polygon.material     = scarColor(props.severidad ?? 2).withAlpha(alpha);
      entity.polygon.outline      = bosque;
      entity.polygon.outlineColor = Cesium.Color.fromCssColorString('#00ff88').withAlpha(0.9);
      entity.polygon.outlineWidth = 2;
      count++;
      totalHa += props.area_ha ?? 0;
      if (bosque)    nBosque++;
      if (verificado) nIdecor++;
      if (props.loteo_superpuesto || props.loteo_post_incendio) nLoteo++;
    }
    viewer.dataSources.add(ds);
    scarDataSource  = ds;
    currentScarYear = year;
    const bosqueNote = nBosque > 0 ? ` · ${nBosque} bosque nativo` : '';
    statusEl.textContent = `Activo · ${count} polígonos · ${year}${bosqueNote}`;

    // Estadísticas
    const statsEl = document.getElementById('scar-stats');
    const haFmt   = Math.round(totalHa).toLocaleString('es-AR');
    let statsHtml = `<strong>${haFmt} ha</strong> quemadas en ${year}`;
    if (nBosque > 0) statsHtml += `<br><span style="color:#00ff88">&#9679; ${nBosque} polígonos con bosque nativo</span>`;
    if (nLoteo  > 0) statsHtml += `<br><span style="color:#22d3ee">&#9632; ${nLoteo} con loteo superpuesto</span>`;
    statsEl.innerHTML     = statsHtml;
    statsEl.style.display = 'block';
  } catch (e) {
    statusEl.textContent = 'Error al cargar';
    document.getElementById('scar-stats').style.display = 'none';
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

  const osmDes    = !!props.osm_desarrollo;
  const osmTipo   = props.osm_tipo   || '';
  const osmNombre = props.osm_nombre || '';
  if (osmDes) {
    html += `<br><span style="color:#c084fc;font-weight:600">&#9670; Desarrollo actual (OSM)`;
    if (osmTipo)   html += `<br><small style="color:#c084fc;font-weight:400">${osmTipo}</small>`;
    if (osmNombre) html += `<br><small style="color:#a78bfa">${osmNombre}</small>`;
    html += `</span>`;
  }

  const loteoPost  = !!props.loteo_post_incendio;
  const loteo      = !!props.loteo_superpuesto;
  const loteoNombre = props.nombre_loteo || '';
  if (loteoPost) {
    html += `<br><span style="color:#22d3ee;font-weight:600">&#x26A0; Loteo aprobado post-incendio`;
    if (loteoNombre) html += `<br><small style="color:#22d3ee;font-weight:400">${loteoNombre}</small>`;
    html += `</span>`;
  } else if (loteo) {
    html += `<br><small style="color:#22d3ee">&#9632; Loteo superpuesto`;
    if (loteoNombre) html += `: ${loteoNombre}`;
    html += `</small>`;
  }

  _currentScarData = {
    year: yr, area_ha: area, severidad: sev, severidad_label: label,
    bosque_nativo: bosque, idecor_verificado: verificado,
    cobertura, localidad,
    departamento:       props.departamento_idecor  || '',
    osm_desarrollo:     osmDes,
    osm_tipo:           osmTipo,
    osm_nombre:         osmNombre,
    loteo_superpuesto:  loteo,
    loteo_post_incendio: loteoPost,
    nombre_loteo:       loteoNombre,
  };
  html += '<br><button class="ai-btn" onclick="openClaudePanel()">🤖 Analizar con IA</button>';

  scarInfoEl.innerHTML = html;
  scarInfoEl.style.display = 'block';
  scarInfoEl.style.left    = x + 'px';
  scarInfoEl.style.top     = y + 'px';
  viewer.scene.canvas.style.cursor = 'crosshair';
  return true;
}

function showOSMTooltip(picked, x, y) {
  if (!Cesium.defined(picked) || !picked.id) {
    osmInfoEl.style.display = 'none';
    return false;
  }
  const entityId = picked.id.id;
  if (!osmInfoMap.has(entityId)) {
    osmInfoEl.style.display = 'none';
    return false;
  }
  const { tipo_label, nombre } = osmInfoMap.get(entityId);
  let html = `<strong style="color:#c084fc">&#9670; ${tipo_label || 'Desarrollo urbano'}</strong>`;
  if (nombre) html += `<br>${nombre}`;
  html += `<br><small style="color:#8b949e">OpenStreetMap</small>`;
  osmInfoEl.innerHTML     = html;
  osmInfoEl.style.display = 'block';
  osmInfoEl.style.left    = x + 'px';
  osmInfoEl.style.top     = y + 'px';
  viewer.scene.canvas.style.cursor = 'crosshair';
  return true;
}

function showLoteoTooltip(picked, x, y) {
  if (!Cesium.defined(picked) || !picked.id) {
    loteoInfoEl.style.display = 'none';
    return false;
  }
  const entityId = picked.id.id;
  if (!loteoInfoMap.has(entityId)) {
    loteoInfoEl.style.display = 'none';
    return false;
  }
  const { nombre, titular, tipo, label } = loteoInfoMap.get(entityId);
  let html = `<strong style="color:#22d3ee">&#9632; Loteo ${label}</strong>`;
  if (nombre)  html += `<br>${nombre}`;
  if (tipo)    html += `<br><small>${tipo}</small>`;
  if (titular) html += `<br><small style="color:#8b949e">${titular}</small>`;
  loteoInfoEl.innerHTML      = html;
  loteoInfoEl.style.display  = 'block';
  loteoInfoEl.style.left     = x + 'px';
  loteoInfoEl.style.top      = y + 'px';
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
    stopScarAnimation();
    document.getElementById('scar-status').textContent = 'Inactivo';
    document.getElementById('scar-stats').style.display = 'none';
  }
});

document.getElementById('scar-year').addEventListener('change', e => {
  if (document.getElementById('scar-toggle').checked) {
    cargarCicatrices(parseInt(e.target.value));
  }
});

// ── Loteos municipales · IDECOR ─────────────────────────────────────────────
async function cargarLoteos() {
  const statusEl = document.getElementById('loteos-status');
  statusEl.textContent = 'Cargando...';
  limpiarLoteos(false);

  const ds = new Cesium.CustomDataSource('loteos');
  loteoInfoMap.clear();

  const sources = [
    { path: 'data/loteos_aprobados.geojson',   label: 'aprobado',   color: Cesium.Color.fromCssColorString('#22d3ee') },
    { path: 'data/loteos_autorizados.geojson', label: 'autorizado', color: Cesium.Color.fromCssColorString('#0891b2') },
  ];

  let total = 0;
  for (const { path, label, color } of sources) {
    try {
      const resp = await fetch(path);
      if (!resp.ok) continue;
      const geojson = await resp.json();
      for (const feat of geojson.features) {
        const props   = feat.properties || {};
        const nombre  = props.nombre || props.nombfant || '';
        const titular = props.titular || '';
        const tipo    = props.tipoloteo || '';
        const geom    = feat.geometry;
        if (!geom) continue;
        const isMulti = geom.type === 'MultiPolygon';
        const polys   = isMulti ? geom.coordinates : [geom.coordinates];
        for (const poly of polys) {
          const outerFlat = poly[0].flatMap(([lon, lat]) => [lon, lat]);
          const holes = poly.slice(1).map(ring =>
            new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(ring.flatMap(([lon, lat]) => [lon, lat]))
            )
          );
          const e = ds.entities.add({
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(
                Cesium.Cartesian3.fromDegreesArray(outerFlat), holes
              ),
              material:      color.withAlpha(0.3),
              clampToGround: true,
            },
          });
          loteoInfoMap.set(e.id, { nombre, titular, tipo, label });
          for (const ring of poly) {
            ds.entities.add({
              polyline: {
                positions:     Cesium.Cartesian3.fromDegreesArray(ring.flatMap(([lon, lat]) => [lon, lat])),
                width:         2,
                material:      color.withAlpha(0.85),
                clampToGround: true,
              },
            });
          }
          total++;
        }
      }
    } catch (e) {
      console.error('loteos:', path, e);
    }
  }

  viewer.dataSources.add(ds);
  loteosDataSource = ds;
  const legendEl = document.getElementById('loteos-legend');
  if (total > 0) {
    statusEl.textContent      = `Activo · ${total} loteos`;
    legendEl.style.display    = 'block';
  } else {
    statusEl.textContent      = 'Sin datos — correr descargar_loteos.py';
    legendEl.style.display    = 'none';
  }
}

function limpiarLoteos(resetStatus = true) {
  if (loteosDataSource) {
    viewer.dataSources.remove(loteosDataSource, true);
    loteosDataSource = null;
  }
  loteoInfoMap.clear();
  loteoInfoEl.style.display = 'none';
  document.getElementById('loteos-legend').style.display = 'none';
  if (resetStatus)
    document.getElementById('loteos-status').textContent = 'Inactivo';
}

document.getElementById('loteos-toggle').addEventListener('change', e => {
  if (e.target.checked) cargarLoteos();
  else limpiarLoteos();
});

// ── Coincidencias detectadas · lista dinámica ────────────────────────────
function _crearBotonCoincidencia(c) {
  const btn = document.createElement('button');
  btn.className   = c.layer === 'osm' ? 'coincidencia-btn osm' : 'coincidencia-btn';
  btn.textContent = c.label;
  btn.addEventListener('click', () => {
    const scarToggle = document.getElementById('scar-toggle');
    const scarYear   = document.getElementById('scar-year');
    if (!scarToggle.checked) {
      scarToggle.checked = true;
      scarToggle.dispatchEvent(new Event('change'));
    }
    scarYear.value = String(c.año);
    scarYear.dispatchEvent(new Event('change'));
    // Activar capa relevante
    const toggleId = c.layer === 'osm' ? 'osm-toggle' : 'loteos-toggle';
    const t = document.getElementById(toggleId);
    if (!t.checked) { t.checked = true; t.dispatchEvent(new Event('change')); }
    // Volar a la zona
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 22000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-65), roll: 0 },
      duration: 2.5,
    });
  });
  return btn;
}

async function poblarCoincidencias() {
  // Coincidencias IDECOR → sección Loteos
  const listLoteo = document.getElementById('coincidencias-list');
  const idecor = [
    { año: 2020, lon: -64.3014, lat: -31.4815, label: '⚠ 2020 · Campos de Manantiales — loteo post-incendio', layer: 'loteos' },
    { año: 2019, lon: -64.0993, lat: -31.3737, label: '⚠ 2019 · Juan Bautista Perlo — loteo post-incendio',   layer: 'loteos' },
    { año: 2020, lon: -64.3239, lat: -31.4410, label: '◼ 2020 · Urbanización Siete Soles — loteo',           layer: 'loteos' },
    { año: 2024, lon: -64.0858, lat: -31.4725, label: '◼ 2024 · Ciudad de mis Sueños — loteo',               layer: 'loteos' },
  ];
  for (const c of idecor)
    listLoteo.appendChild(_crearBotonCoincidencia(c));

  // Coincidencias OSM → sección OSM
  const listOSM = document.getElementById('coincidencias-osm-list');
  let osmCoinc = [];
  try {
    const resp = await fetch('data/coincidencias_osm.json');
    if (resp.ok) osmCoinc = await resp.json();
  } catch (_) {}

  const osmNamed = osmCoinc.filter(c => c.nombre);
  for (const c of osmNamed)
    listOSM.appendChild(_crearBotonCoincidencia({
      año:   c.year,
      lon:   c.lon,
      lat:   c.lat,
      label: c.label,
      layer: 'osm',
    }));
}

poblarCoincidencias();

// ── Desarrollo urbano OSM · OpenStreetMap ────────────────────────────────
async function cargarOSM() {
  const statusEl = document.getElementById('osm-status');
  statusEl.textContent = 'Cargando...';
  limpiarOSM(false);

  const ds = new Cesium.CustomDataSource('osm');
  osmInfoMap.clear();

  try {
    const resp = await fetch('data/osm_desarrollo.geojson');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const geojson = await resp.json();
    let total = 0;

    for (const feat of geojson.features) {
      const props   = feat.properties || {};
      const tipo    = props.tipo || '';
      const color   = osmColor(tipo);
      const geom    = feat.geometry;
      if (!geom) continue;
      const isMulti = geom.type === 'MultiPolygon';
      const polys   = isMulti ? geom.coordinates : [geom.coordinates];

      for (const poly of polys) {
        const outerFlat = poly[0].flatMap(([lon, lat]) => [lon, lat]);
        const holes = poly.slice(1).map(ring =>
          new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(ring.flatMap(([lon, lat]) => [lon, lat]))
          )
        );
        const e = ds.entities.add({
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(outerFlat), holes
            ),
            material:      color.withAlpha(0.28),
            clampToGround: true,
          },
        });
        osmInfoMap.set(e.id, {
          tipo_label: props.tipo_label || tipo,
          nombre:     props.nombre || '',
        });
        for (const ring of poly) {
          ds.entities.add({
            polyline: {
              positions:     Cesium.Cartesian3.fromDegreesArray(ring.flatMap(([lon, lat]) => [lon, lat])),
              width:         1.5,
              material:      color.withAlpha(0.8),
              clampToGround: true,
            },
          });
        }
        total++;
      }
    }

    viewer.dataSources.add(ds);
    osmDataSource = ds;
    document.getElementById('osm-legend').style.display = 'block';
    statusEl.textContent = `Activo · ${total} features`;
  } catch (e) {
    console.error('osm:', e);
    statusEl.textContent = 'Sin datos — correr enrich_osm.py';
  }
}

function limpiarOSM(resetStatus = true) {
  if (osmDataSource) {
    viewer.dataSources.remove(osmDataSource, true);
    osmDataSource = null;
  }
  osmInfoMap.clear();
  osmInfoEl.style.display = 'none';
  document.getElementById('osm-legend').style.display = 'none';
  if (resetStatus)
    document.getElementById('osm-status').textContent = 'Inactivo';
}

document.getElementById('osm-toggle').addEventListener('change', e => {
  if (e.target.checked) cargarOSM();
  else limpiarOSM();
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

// ── Animación por año ────────────────────────────────────────────────────────
const SCAR_YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
let   scarAnimTimer = null;

function stopScarAnimation() {
  if (scarAnimTimer) { clearTimeout(scarAnimTimer); scarAnimTimer = null; }
  const btn = document.getElementById('scar-play-btn');
  if (btn) { btn.textContent = '▶'; btn.classList.remove('playing'); }
}

function advanceScarYear() {
  const sel = document.getElementById('scar-year');
  const cur = parseInt(sel.value);
  const idx = SCAR_YEARS.indexOf(cur);
  const next = SCAR_YEARS[(idx + 1) % SCAR_YEARS.length];
  sel.value = String(next);
  sel.dispatchEvent(new Event('change'));
  if (next !== SCAR_YEARS[SCAR_YEARS.length - 1]) {
    scarAnimTimer = setTimeout(advanceScarYear, 2000);
  } else {
    stopScarAnimation();
  }
}

document.getElementById('scar-play-btn').addEventListener('click', () => {
  if (scarAnimTimer) { stopScarAnimation(); return; }
  const btn = document.getElementById('scar-play-btn');
  btn.textContent = '⏹';
  btn.classList.add('playing');
  // Empieza desde 2018
  const sel = document.getElementById('scar-year');
  sel.value = '2018';
  sel.dispatchEvent(new Event('change'));
  scarAnimTimer = setTimeout(advanceScarYear, 2000);
});

// ── Casos de alerta (Fase 4) ─────────────────────────────────────────────────
async function poblarCasosAlerta() {
  const listEl = document.getElementById('casos-list');
  try {
    const resp = await fetch('data/casos_alerta.json');
    if (!resp.ok) throw new Error('sin datos');
    const casos = await resp.json();

    listEl.innerHTML = '';
    for (const c of casos) {
      const btn = document.createElement('button');
      btn.className = 'caso-btn';

      const tags = [];
      if (c.recurrencia >= 2) tags.push(`🔁 ${c.recurrencia}x`);
      if (c.bosque_nativo)    tags.push('🌿 bosque');
      if (c.loteo_post)       tags.push('⚠ loteo');
      if (c.osm_alto_valor)   tags.push('⛳ desarrollo');

      btn.innerHTML =
        `<span class="caso-score">⚠ ${c.score}</span>` +
        `<strong>${c.year} · ${c.area_ha.toLocaleString('es-AR')} ha</strong>` +
        (c.localidad ? ` · ${c.localidad}` : '') +
        `<span class="caso-tags">${tags.join(' · ')}</span>`;

      btn.addEventListener('click', () => {
        // Activar cicatrices del año del caso
        const scarToggle = document.getElementById('scar-toggle');
        const scarYear   = document.getElementById('scar-year');
        if (!scarToggle.checked) {
          scarToggle.checked = true;
          scarToggle.dispatchEvent(new Event('change'));
        }
        scarYear.value = String(c.year);
        scarYear.dispatchEvent(new Event('change'));
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 35000),
          orientation: { heading: 0, pitch: Cesium.Math.toRadians(-60), roll: 0 },
          duration: 2,
        });
      });

      listEl.appendChild(btn);
    }
    if (casos.length === 0)
      listEl.innerHTML = '<small style="color:var(--text-muted)">Sin datos — correr generar_casos_alerta.py</small>';
  } catch {
    listEl.innerHTML = '<small style="color:var(--text-muted)">Sin datos — correr generar_casos_alerta.py</small>';
  }
}
poblarCasosAlerta();

// ── Recurrencia de incendios ─────────────────────────────────────────────────
function recurrenciaColor(n) {
  if (n >= 5) return '#7c0000';
  if (n === 4) return '#dc2626';
  if (n === 3) return '#f97316';
  return '#facc15';
}

async function cargarRecurrencia() {
  const statusEl = document.getElementById('recurrencia-status');
  statusEl.textContent = 'Cargando...';
  limpiarRecurrencia(false);

  try {
    const resp  = await fetch('data/recurrencia.geojson');
    if (!resp.ok) throw new Error('sin datos');
    const geojson = await resp.json();

    const ds = new Cesium.CustomDataSource('recurrencia');
    let count = 0;

    for (const feat of geojson.features) {
      const props  = feat.properties;
      const veces  = props.veces_quemado ?? 2;
      const area   = props.area_ha ?? 0;
      const color  = Cesium.Color.fromCssColorString(recurrenciaColor(veces)).withAlpha(0.55);
      const geom   = feat.geometry;
      const isMulti = geom.type === 'MultiPolygon';
      const polys  = isMulti ? geom.coordinates : [geom.coordinates];

      for (const poly of polys) {
        const outerFlat = poly[0].flatMap(([lon, lat]) => [lon, lat]);
        const e = ds.entities.add({
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(outerFlat)
            ),
            material:      color,
            clampToGround: true,
          },
        });
        recurrenciaMap.set(e.id, { veces, area_ha: area });
        count++;
      }
    }

    viewer.dataSources.add(ds);
    recurrenciaDS = ds;
    const legend = document.getElementById('recurrencia-legend');
    legend.style.display = 'block';
    statusEl.textContent = `Activo · ${count} zonas`;
  } catch (e) {
    statusEl.textContent = 'Sin datos — correr generar_recurrencia.py';
    console.error('recurrencia:', e);
  }
}

function limpiarRecurrencia(resetStatus = true) {
  if (recurrenciaDS) {
    viewer.dataSources.remove(recurrenciaDS, true);
    recurrenciaDS = null;
  }
  recurrenciaMap.clear();
  recurrenciaInfoEl.style.display = 'none';
  document.getElementById('recurrencia-legend').style.display = 'none';
  if (resetStatus)
    document.getElementById('recurrencia-status').textContent = 'Inactivo';
}

document.getElementById('recurrencia-toggle').addEventListener('change', e => {
  if (e.target.checked) cargarRecurrencia();
  else limpiarRecurrencia();
});

// ── Claude API · Análisis de cicatrices ──────────────────────────────────────
// La key vive en Cloudflare como secreto — nunca en este archivo.
// Cambiá esta URL por la de tu worker después de desplegarlo.
const WORKER_URL = 'https://incendios-ai.matias-sv91.workers.dev';

function openClaudePanel() {
  if (!_currentScarData) return;
  const panel = document.getElementById('claude-panel');
  panel.style.display = 'flex';
  runClaudeAnalysis();
}

async function runClaudeAnalysis() {
  const content = document.getElementById('claude-content');
  content.innerHTML = '<p class="claude-loading"></p>';

  try {
    const resp = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 450,
        messages: [{ role: 'user', content: buildClaudePrompt(_currentScarData) }],
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${resp.status}`);
    }
    const result = await resp.json();
    const text   = result.content?.[0]?.text || '(sin respuesta)';
    content.innerHTML = formatClaudeText(text);
  } catch (e) {
    content.innerHTML = `<p class="claude-error">Error: ${e.message}</p>`;
  }
}

function buildClaudePrompt(d) {
  const bosque     = d.bosque_nativo        ? 'SÍ' : 'no';
  const verificado = d.idecor_verificado    ? 'SÍ' : 'no';
  const loteoPost  = d.loteo_post_incendio  ? `SÍ — ${d.nombre_loteo || 'sin nombre'}` : 'no';
  const loteo      = d.loteo_superpuesto    ? `SÍ — ${d.nombre_loteo || 'sin nombre'}` : 'no';
  const recurrencia = d.veces_quemado
    ? `SÍ — quemada ${d.veces_quemado} veces entre 2018–2025`
    : 'no (primera vez o sin dato)';

  // Distinguir OSM de alto valor (golf, resort, hotel) vs residencial genérico
  let osmLinea = '- Desarrollo en zona quemada (OSM): no';
  if (d.osm_desarrollo) {
    const tipoLower = (d.osm_tipo || '').toLowerCase();
    const esAltoValor = tipoLower.includes('golf') || tipoLower.includes('resort') ||
                        tipoLower.includes('hotel') || tipoLower.includes('camping') ||
                        tipoLower.includes('estancia');
    const nombre = d.osm_nombre ? ` — "${d.osm_nombre}"` : '';
    if (esAltoValor) {
      osmLinea = `- Desarrollo de alto valor económico sobre la cicatriz (OSM): SÍ — ${d.osm_tipo}${nombre}
  → SEÑAL A EVALUAR: campos de golf, resorts y establecimientos turísticos que se superponen con cicatrices de incendio pueden indicar que el fuego habilitó ese uso del suelo. Mencionalo en "Señales de alerta" si hay bosque nativo afectado.`;
    } else {
      osmLinea = `- Desarrollo urbano preexistente en la zona (OSM, solo contexto): SÍ — ${d.osm_tipo}${nombre}`;
    }
  }

  return `Sos un analista ambiental experto en incendios forestales en las Sierras de Córdoba, Argentina. Generá una síntesis directa (máximo 170 palabras) en tres partes con encabezados en negrita.

**Qué ocurrió**
Describí el incendio brevemente.

**Impacto ecológico**
Qué se perdió y por qué importa.

**Señales de alerta**
Evaluá estas señales por separado, de mayor a menor gravedad:
1. Recurrencia: zona quemada múltiples veces — señal fuerte de incendio sistemático/intencional.
2. Loteo post-incendio: subdivisión municipal aprobada DESPUÉS del incendio — señal grave de cambio de uso ilegal.
3. Desarrollo de alto valor sobre la cicatriz (golf, resort, hotel): puede indicar que el fuego despejó suelo para ese uso.
Si no hay ninguna señal, decilo claramente sin rodeos.

Datos:
- Año: ${d.year}
- Área: ~${d.area_ha} ha
- Severidad: ${d.severidad_label} (clase ${d.severidad})
- Departamento: ${d.departamento || 'sin dato'}
- Localidad IDECOR: ${d.localidad || 'sin dato'}
- Verificado IDECOR: ${verificado}
- Bosque nativo quemado: ${bosque}
- Cobertura vegetal: ${d.cobertura || 'sin dato'}
${osmLinea}
- Recurrencia (zona quemada en años anteriores): ${recurrencia}
- Loteo municipal aprobado POST-incendio: ${loteoPost}
- Loteo municipal superpuesto: ${loteo}

Ley 26.331 y Ley 9.814 provincial: prohíben cambiar el uso del suelo en bosque nativo categorías I y II.

Sé directo y objetivo.`;
}

function formatClaudeText(raw) {
  const html = raw
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .split(/\n\n+/)
    .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<div class="claude-text">${html}</div>`;
}

document.getElementById('claude-close-btn').addEventListener('click', () => {
  document.getElementById('claude-panel').style.display = 'none';
});
