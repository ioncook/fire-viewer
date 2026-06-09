// CALIFORNIA FIRE HISTORY VISUALIZER — app.js
maplibregl.prewarm();
maplibregl.workerCount = Math.max(2, navigator.hardwareConcurrency || 2);

// ---- Global State ----
let allFeatures = [];       // raw GeoJSON features (contains fires.geojson)
let currentPopup = null;
let currentBasemap = 'dark';
let colorMode = 'decade';
let opacityVal = 0.65;
let currentUnits = 'imperial'; // 'imperial' | 'metric'
let activeFilters = { yearMin: 1870, yearMax: 2025, cause: 'all', size: 0 };
let filteredCount = 0;
let filteredAcres = 0;
let filteredLargest = '';
let dataLoaded = false;
let highResLoaded = false;
let loadedStates = {};
let highResFeatures = [];
let terrainMode = 'off';
let terrainExaggeration = 1.5;
let currentProjection = 'mercator'; // 'mercator' | 'globe'
let currentBorders = 'state';

// ---- Settings Persistence ----
function saveSettings() {
  const settings = {
    units: currentUnits,
    basemap: currentBasemap,
    opacity: opacityVal,
    colorMode: colorMode,
    terrain: terrainMode,
    exaggeration: terrainExaggeration,
    projection: currentProjection,
    borders: currentBorders,
    theme: document.body.classList.contains('light-mode') ? 'light' : 'dark'
  };
  localStorage.setItem('fire_visualizer_settings', JSON.stringify(settings));
}

function loadSettings() {
  const saved = localStorage.getItem('fire_visualizer_settings');
  if (saved) {
    try {
      const s = JSON.parse(saved);
      if (s.units) currentUnits = s.units;
      if (s.basemap) currentBasemap = s.basemap;
      if (s.opacity !== undefined) opacityVal = s.opacity;
      if (s.colorMode) colorMode = s.colorMode;
      if (s.projection) currentProjection = s.projection;
      if (s.borders) currentBorders = s.borders;
      if (s.terrain !== undefined) {
        if (typeof s.terrain === 'boolean') {
          terrainMode = s.terrain ? '3d' : 'off';
        } else {
          terrainMode = s.terrain;
        }
      }
      if (s.exaggeration !== undefined) terrainExaggeration = s.exaggeration;
      if (s.theme) document.body.classList.toggle('light-mode', s.theme === 'light');
    } catch (e) { console.warn('Failed to load settings', e); }
  }
}
loadSettings();

// popup stack navigation
let clickFeatures = [];
let clickIndex = 0;
let currentPopupLngLat = null;
let currentCounty = ''; // fetched on click

// ---- Cause labels ----
const CAUSE_LABELS = {
  1: 'Lightning', 2: 'Equipment', 3: 'Smoking', 4: 'Campfire',
  5: 'Debris', 6: 'Railroad', 7: 'Arson', 8: 'Playing w/Fire',
  9: 'Miscellaneous', 10: 'Vehicle', 11: 'Power Line',
  12: 'Firefighter Training', 13: 'Non-FF Training',
  14: 'Unknown', 15: 'Structure', 16: 'Aircraft',
  17: 'Esc. Prescribed Burn', 18: 'Illegal Campfire', 19: 'Other'
};

// ---- Agency labels ----
const AGENCY_LABELS = {
  'CDF': 'CAL FIRE', 'USF': 'US Forest Service', 'NPS': 'Natl Park Service',
  'BLM': 'Bureau of Land Mgmt', 'FWS': 'Fish & Wildlife Svc', 'OTH': 'Other Agency',
  'CCO': 'Cal Conservancy', 'BIA': 'Bureau of Indian Affairs'
};

// ---- Season helper ----
function getSeason(dateStr) {
  if (!dateStr) return 'Unknown';
  const m = parseInt(dateStr.slice(5, 7));
  if (m >= 3 && m <= 5) return 'Spring';
  if (m >= 6 && m <= 8) return 'Summer';
  if (m >= 9 && m <= 11) return 'Fall';
  return 'Winter';
}

// ---- Color palettes ----
const DECADE_COLORS = {
  1870: '#9c27b0', 1890: '#673ab7', 1900: '#3f51b5',
  1910: '#2196f3', 1920: '#03a9f4', 1930: '#00bcd4',
  1940: '#009688', 1950: '#4caf50', 1960: '#8bc34a',
  1970: '#cddc39', 1980: '#ffeb3b', 1990: '#ffc107',
  2000: '#ff9800', 2010: '#ff5722', 2020: '#f44336'
};

const CAUSE_COLORS = {
  1: '#4fc3f7', 7: '#ef5350', 2: '#ffa726', 5: '#8d6e63',
  4: '#ffca28', 11: '#ab47bc', 10: '#ec407a', 9: '#bdbdbd',
  14: '#607d8b', 3: '#a5d6a7', 6: '#4db6ac', 8: '#ff8a65',
  12: '#90caf9', 13: '#80deea', 15: '#ce93d8', 16: '#fff176',
  17: '#69f0ae', 18: '#bcaaa4', 19: '#9e9e9e'
};

const SEASON_COLORS = {
  'Winter': '#7986cb', 'Spring': '#81c784', 'Summer': '#ff8f00', 'Fall': '#e53935'
};

function getDecadeKey(year) {
  return Math.floor(year / 10) * 10;
}

// ---- Continuous gradient color stops ----
const YEAR_COLOR_STOPS = Object.entries(DECADE_COLORS)
  .sort((a, b) => a[0] - b[0])
  .map(([y, c]) => [parseInt(y), c]);

const SIZE_COLOR_STOPS = [
  [0, '#00b4d8'], [100, '#00f5d4'], [1000, '#4caf50'],
  [10000, '#ffeb3b'], [50000, '#ff9800'], [100000, '#f44336'], [500000, '#9c27b0']
];

function lerpHex(c1, c2, t) {
  const r1 = parseInt(c1.slice(1, 3), 16), g1 = parseInt(c1.slice(3, 5), 16), b1 = parseInt(c1.slice(5, 7), 16);
  const r2 = parseInt(c2.slice(1, 3), 16), g2 = parseInt(c2.slice(3, 5), 16), b2 = parseInt(c2.slice(5, 7), 16);
  const r = Math.round(r1 + (r2 - r1) * t).toString(16).padStart(2, '0');
  const g = Math.round(g1 + (g2 - g1) * t).toString(16).padStart(2, '0');
  const b = Math.round(b1 + (b2 - b1) * t).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

function interpolateColor(stops, value) {
  if (value <= stops[0][0]) return stops[0][1];
  if (value >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (value >= stops[i][0] && value <= stops[i + 1][0]) {
      const t = (value - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
      return lerpHex(stops[i][1], stops[i + 1][1], t);
    }
  }
  return stops[stops.length - 1][1];
}

function getFeatureColor(props) {
  const year = props.y || 0;
  const cause = props.c || 14;
  const acres = props.ac || 0;
  const SEASON_NAMES = { 1: 'Spring', 2: 'Summer', 3: 'Fall', 4: 'Winter' };
  const season = SEASON_NAMES[props.se] || 'Unknown';

  if (colorMode === 'decade') return interpolateColor(YEAR_COLOR_STOPS, year);
  if (colorMode === 'cause') return CAUSE_COLORS[cause] || '#888';
  if (colorMode === 'size') return interpolateColor(SIZE_COLOR_STOPS, acres);
  if (colorMode === 'season') return SEASON_COLORS[season] || '#888';
  return '#ff5c1a';
}

// ---- MapLibre Setup ----
const BASEMAPS = {
  dark: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
  light: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
  satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  topo: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png'
};

const BASEMAP_ATTRS = {
  dark: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  light: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  satellite: '&copy; Esri, Earthstar Geographics',
  topo: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | &copy; opentopomap.org'
};

const map = new maplibregl.Map({
  container: 'map',
  style: { version: 8, sources: {}, layers: [] },
  center: [-116.0, 44.0],
  zoom: 4.0,
  maxZoom: 16,
  antialias: true,
  trackResize: true,
  attributionControl: true,
});

// ---- Hash sync ----
function updateHash() {
  const center = map.getCenter();
  const zoom = map.getZoom().toFixed(2);
  const { yearMin, yearMax, cause, size } = activeFilters;
  const hash = `#${zoom}/${center.lat.toFixed(5)}/${center.lng.toFixed(5)}/${yearMin}/${yearMax}/${cause}/${Math.round(size)}`;
  history.replaceState(null, '', hash);
}
function loadHash() {
  const hash = window.location.hash.substring(1);
  if (!hash) return;
  const parts = hash.split('/');
  if (parts.length >= 3) {
    map.jumpTo({
      zoom: parseFloat(parts[0]),
      center: [parseFloat(parts[2]), parseFloat(parts[1])]
    });
  }
  if (parts.length >= 7) {
    activeFilters.yearMin = parseInt(parts[3]) || 1870;
    activeFilters.yearMax = parseInt(parts[4]) || 2025;
    activeFilters.cause = parts[5] || 'all';
    activeFilters.size = parseFloat(parts[6]) || 0;
  }
}
loadHash();

function loadStateHighRes(code) {
  if (loadedStates[code]) return;
  loadedStates[code] = 'loading';

  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = `Loading details for ${code}…`;

  fetch(`./states/fires_${code}.geojson`)
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(geojson => {
      const features = geojson.features || [];
      processFeatures(features);

      // Merge new high-res features
      highResFeatures = highResFeatures.concat(features);
      loadedStates[code] = 'loaded';

      // Replace low-res features in allFeatures
      allFeatures = allFeatures.filter(f => !(f.properties && f.properties.st === code));
      allFeatures = allFeatures.concat(features);

      const loadedList = Object.keys(loadedStates).filter(k => loadedStates[k] === 'loaded').join(', ');
      if (statusEl) {
        statusEl.textContent = `Loaded detail for ${loadedList}`;
      }

      updateViewportData();
      updateStats();
    })
    .catch(err => {
      console.error(`Failed to load high-res perimeters for ${code}:`, err);
      loadedStates[code] = null; // allow retry
    });
}

function updateViewportData() {
  if (!dataLoaded) return;

  const zoom = map.getZoom();

  // If zoomed out, clear high-res source to free memory and CPU
  if (zoom < 6.5) {
    const source = map.getSource('fires-source');
    if (source) {
      source.setData({ type: 'FeatureCollection', features: [] });
    }
    return;
  }

  const bounds = map.getBounds();
  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = bounds.getSouth();
  const north = bounds.getNorth();

  // Add 10% padding buffer around viewport to avoid edge clipping / pop-in during small pans
  const padLng = (east - west) * 0.1;
  const padLat = (north - south) * 0.1;

  const w = west - padLng;
  const e = east + padLng;
  const s = south - padLat;
  const n = north + padLat;

  // Identify visible states and trigger background load
  for (const [code, stBounds] of Object.entries(STATE_BOUNDS)) {
    const stMinLng = stBounds[0][0];
    const stMinLat = stBounds[0][1];
    const stMaxLng = stBounds[1][0];
    const stMaxLat = stBounds[1][1];

    if (stMaxLng >= w && stMinLng <= e && stMaxLat >= s && stMinLat <= n) {
      if (!loadedStates[code]) {
        loadStateHighRes(code);
      }
    }
  }

  // Filter whatever features are in allFeatures (handles both loaded high-res and fallback low-res)
  const filtered = [];
  for (let i = 0; i < allFeatures.length; i++) {
    const feat = allFeatures[i];
    if (feat.bbox) {
      const [fW, fS, fE, fN] = feat.bbox;
      if (fE >= w && fW <= e && fN >= s && fS <= n) {
        filtered.push(feat);
      }
    } else {
      filtered.push(feat);
    }
  }

  const source = map.getSource('fires-source');
  if (source) {
    source.setData({
      type: 'FeatureCollection',
      features: filtered
    });
  }
}

let lastZoom = map.getZoom();
map.on('zoom', () => {
  const zoom = map.getZoom();
  // Only trigger updates immediately when crossing the visibility threshold
  if ((zoom >= 6.5 && lastZoom < 6.5) || (zoom < 6.5 && lastZoom >= 6.5)) {
    updateViewportData();
  }
  lastZoom = zoom;
});

map.on('moveend', () => {
  updateHash();
  updateViewportData();
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

window.addEventListener('resize', () => map.resize());

// ---- Basemap setup ----
function setupBasemap(id) {
  const url = BASEMAPS[id];
  const attr = BASEMAP_ATTRS[id];

  if (map.getLayer('basemap-layer')) map.removeLayer('basemap-layer');
  if (map.getSource('basemap-source')) map.removeSource('basemap-source');

  map.addSource('basemap-source', {
    type: 'raster',
    tiles: [url],
    tileSize: 256,
    attribution: attr
  });

  map.addLayer({
    id: 'basemap-layer', type: 'raster', source: 'basemap-source',
    paint: { 'raster-fade-duration': 0 }
  }, 'overlay-anchor');

  currentBasemap = id;
}

// ---- Projection setup ----
function setupProjection(type) {
  currentProjection = type;
  map.setProjection({ type: type });
}

// ---- 3D Terrain & Hillshade ----
function setupTerrain(mode, exaggeration = terrainExaggeration) {
  terrainMode = mode;
  terrainExaggeration = parseFloat(exaggeration);
  const viz = (mode === 'hillshade' || mode === '3d') ? 'visible' : 'none';

  if (mode === '3d') {
    if (!map.getSource('terrain-source')) {
      map.addSource('terrain-source', {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 15
      });
    }
    map.setTerrain({ source: 'terrain-source', exaggeration: terrainExaggeration });
  } else {
    map.setTerrain(null);
    try {
      if (map.painter && map.painter.terrain) map.painter.terrain = null;
      if (map.transform && map.transform._elevation !== undefined) map.transform._elevation = 0;
      if (map.transform && map.transform.elevation !== undefined) map.transform.elevation = 0;
    } catch (e) { }
    map.triggerRepaint();
  }

  if (viz === 'visible') {
    if (!map.getSource('terrain-source')) {
      map.addSource('terrain-source', {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 15
      });
    }

    if (!map.getLayer('hillshade-layer')) {
      map.addLayer({
        id: 'hillshade-layer',
        type: 'hillshade',
        source: 'terrain-source',
        paint: {
          'hillshade-exaggeration': 0.4,
          'hillshade-shadow-color': 'rgba(0,0,0,0.5)',
          'hillshade-highlight-color': 'rgba(255,255,255,0.1)'
        }
      });
    } else {
      map.setLayoutProperty('hillshade-layer', 'visibility', 'visible');
    }
    // Make sure hillshade layer is ALWAYS on top of the fires
    map.moveLayer('hillshade-layer');
  } else {
    if (map.getLayer('hillshade-layer')) {
      map.setLayoutProperty('hillshade-layer', 'visibility', 'none');
    }
  }
}

// ---- Filter logic ----
function matchesFilters(props) {
  const y = props.y || 0;
  if (y < activeFilters.yearMin || y > activeFilters.yearMax) return false;
  if (activeFilters.cause !== 'all') {
    if (String(props.c) !== activeFilters.cause) return false;
  }
  if (activeFilters.size > 0) {
    if ((props.ac || 0) < activeFilters.size) return false;
  }
  return true;
}

// ---- Calculate Stats & Update Sidebar ----
// ---- Calculate Stats & Update Sidebar ----
function updateStats() {
  let count = 0, acres = 0, largestAc = 0, largestName = '';

  for (const f of allFeatures) {
    if (matchesFilters(f.properties)) {
      count++;
      const ac = f.properties.ac || 0;
      acres += ac;
      if (ac > largestAc) {
        largestAc = ac;
        largestName = f.properties.n || 'Unnamed';
      }
    }
  }

  filteredCount = count;
  filteredAcres = acres;
  filteredLargest = largestAc > 0 ? `${largestName} (${formatAcres(largestAc)})` : '—';

  const statusEl = document.getElementById('status');
  if (statusEl) {
    const isFiltered = activeFilters.yearMin > 1870 || activeFilters.yearMax < 2025
      || activeFilters.cause !== 'all' || activeFilters.size > 0;
    const isLoading = Object.values(loadedStates).includes('loading');
    const loadingStr = isLoading ? ' (loading detail...)' : '';
    statusEl.textContent = `${label} · ${formatCount(filteredCount)} shown${loadingStr}`;
  }
}

// ---- Build MapLibre filter expression ----
function buildMapFilter() {
  const filter = [
    'all',
    ['>=', ['get', 'y'], activeFilters.yearMin],
    ['<=', ['get', 'y'], activeFilters.yearMax],
    ['>=', ['get', 'ac'], activeFilters.size]
  ];
  if (activeFilters.cause !== 'all') {
    filter.push(['==', ['to-string', ['get', 'c']], activeFilters.cause]);
  }
  return filter;
}

// ---- Build MapLibre fill-color expression ----
function buildColorExpression() {
  let base;
  if (colorMode === 'decade') {
    const flat = YEAR_COLOR_STOPS.flatMap(([y, c]) => [y, c]);
    base = ['interpolate', ['linear'], ['get', 'y'], ...flat];
  } else if (colorMode === 'cause') {
    const expr = ['match', ['get', 'c']];
    for (const [k, v] of Object.entries(CAUSE_COLORS)) {
      expr.push(parseInt(k), v);
    }
    expr.push('#888');
    base = expr;
  } else if (colorMode === 'size') {
    const flat = SIZE_COLOR_STOPS.flatMap(([s, c]) => [s, c]);
    base = ['interpolate', ['linear'], ['get', 'ac'], ...flat];
  } else if (colorMode === 'season') {
    base = ['match', ['get', 'se'],
      1, '#81c784', // Spring
      2, '#ff8f00', // Summer
      3, '#e53935', // Fall
      4, '#7986cb', // Winter
      '#7986cb'     // Default (Winter)
    ];
  } else {
    base = '#ff5c1a';
  }

  return base;
}

// ---- Apply layers ----
function applyFireLayers() {
  updateStats();
  const colorExpr = buildColorExpression();
  const filterExpr = buildMapFilter();

  // Apply to low-res layers if present
  if (map.getSource('fires-lowres-source')) {
    if (map.getLayer('fires-fill-lowres')) {
      map.setFilter('fires-fill-lowres', filterExpr);
      map.setPaintProperty('fires-fill-lowres', 'fill-color', colorExpr);
      map.setPaintProperty('fires-fill-lowres', 'fill-opacity', ['case',
        ['any', ['boolean', ['feature-state', 'hover'], false], ['boolean', ['feature-state', 'popup'], false]],
        Math.min(opacityVal + 0.35, 1.0),
        opacityVal * 0.75
      ]);
    }
    if (map.getLayer('fires-outline-lowres')) {
      map.setFilter('fires-outline-lowres', filterExpr);
      map.setPaintProperty('fires-outline-lowres', 'line-color', colorExpr);
    }
  }

  // Apply to high-res layers if present
  if (map.getSource('fires-source')) {
    if (map.getLayer('fires-fill')) {
      map.setFilter('fires-fill', filterExpr);
      map.setPaintProperty('fires-fill', 'fill-color', colorExpr);
      map.setPaintProperty('fires-fill', 'fill-opacity', ['case',
        ['any', ['boolean', ['feature-state', 'hover'], false], ['boolean', ['feature-state', 'popup'], false]],
        Math.min(opacityVal + 0.35, 1.0),
        opacityVal * 0.75
      ]);
    }
    if (map.getLayer('fires-outline')) {
      map.setFilter('fires-outline', filterExpr);
      map.setPaintProperty('fires-outline', 'line-color', colorExpr);
    }
    updateViewportData();
  }

  if (map.getLayer('hillshade-layer') && map.getLayoutProperty('hillshade-layer', 'visibility') !== 'none') {
    map.moveLayer('hillshade-layer');
  }
  updateLegend();
}

// ---- Cursor: grab default, grabbing (fist) on drag/tilt/rotate ----
map.on('dragstart', () => { map.getCanvas().style.cursor = 'grabbing'; });
map.on('dragend', () => { map.getCanvas().style.cursor = 'grab'; });
map.on('pitchstart', () => { map.getCanvas().style.cursor = 'grabbing'; });
map.on('pitchend', () => { map.getCanvas().style.cursor = 'grab'; });
map.on('rotatestart', () => { map.getCanvas().style.cursor = 'grabbing'; });
map.on('rotateend', () => { map.getCanvas().style.cursor = 'grab'; });

// ---- Hover & Popup state ----
let hoveredId = null;
let hoveredSource = null;
let popupActiveId = null;
let popupActiveSource = null;

function setupFireLayerEvents(layerId, sourceId) {
  map.on('mousemove', layerId, (e) => {
    map.getCanvas().style.cursor = 'pointer';
    if (e.features && e.features.length > 0) {
      const sorted = e.features.slice().sort((a, b) => (a.properties.ac || 0) - (b.properties.ac || 0));
      const topFeature = sorted[0];

      if (hoveredId !== null && (hoveredId !== topFeature.id || hoveredSource !== sourceId)) {
        try {
          map.setFeatureState({ source: hoveredSource, id: hoveredId }, { hover: false });
        } catch (err) {}
      }
      hoveredId = topFeature.id;
      hoveredSource = sourceId;
      map.setFeatureState({ source: hoveredSource, id: hoveredId }, { hover: true });
    }
  });

  map.on('mouseleave', layerId, () => {
    if (!map.isMoving()) map.getCanvas().style.cursor = 'grab';
    if (hoveredId !== null && hoveredSource !== null) {
      try {
        map.setFeatureState({ source: hoveredSource, id: hoveredId }, { hover: false });
      } catch (err) {}
    }
    hoveredId = null;
    hoveredSource = null;
  });

  map.on('click', layerId, (e) => {
    if (!e.features || e.features.length === 0) return;

    clickFeatures = e.features.slice().sort((a, b) =>
      (a.properties.ac || 0) - (b.properties.ac || 0) ||
      (b.properties.y || 0) - (a.properties.y || 0)
    );
    clickIndex = 0;
    currentPopupLngLat = e.lngLat;
    currentCounty = '';

    fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${e.lngLat.lat}&lon=${e.lngLat.lng}&zoom=10`)
      .then(r => r.json())
      .then(data => {
        if (data && data.address && data.address.county) {
          currentCounty = data.address.county;
          if (currentPopup && currentPopup.isOpen()) renderFirePopup();
        }
      })
      .catch(() => { });

    renderFirePopup();
  });
}

// ---- Popup builder ----
function buildFirePopupHTML() {
  const props = clickFeatures[clickIndex].properties;
  const total = clickFeatures.length;
  const idx = clickIndex;

  const name = props.n || 'Unnamed';
  const year = props.y || '?';
  const agency = AGENCY_LABELS[props.ag] || props.ag || 'Unknown';
  const acres = props.ac ? formatAcres(props.ac) : '—';
  const cause = CAUSE_LABELS[props.c] || 'Unknown';
  const SEASON_NAMES = { 1: 'Spring', 2: 'Summer', 3: 'Fall', 4: 'Winter' };
  const season = SEASON_NAMES[props.se] || 'Unknown';
  const dur = calcDuration(props.ad, props.cd);

  const decadeColor = interpolateColor(YEAR_COLOR_STOPS, year);
  const causeColor = CAUSE_COLORS[props.c] || '#aaa';
  const seasonColor = SEASON_COLORS[season] || '#aaa';
  const featureColor = getFeatureColor(props);
  const sizeColor = interpolateColor(SIZE_COLOR_STOPS, props.ac || 0);

  const lat = currentPopupLngLat ? currentPopupLngLat.lat.toFixed(3) : '0.000';
  const lng = currentPopupLngLat ? currentPopupLngLat.lng : 0;
  const lngDisp = Math.abs(lng).toFixed(3);
  const googleMapsUrl = `https://www.google.com/maps?q=${lat},${lng.toFixed(6)}`;

  const locHtml = `<a href="${googleMapsUrl}" target="_blank" style="color:inherit; text-decoration:underline; text-underline-offset:2px;">${lat}°N, ${lngDisp}°W</a>${currentCounty ? ', ' + currentCounty : ''}`;

  let dateRange = '—';
  if (props.ad) {
    dateRange = formatDate(props.ad);
    if (props.cd && props.cd !== props.ad) {
      dateRange += ` – ${formatDate(props.cd)}`;
      if (dur) dateRange += ` (${dur})`;
    }
  }

  const prevDisabled = idx === 0;
  const nextDisabled = idx === total - 1;
  const navHtml = total > 1 ? `
    <div style="display:flex; align-items:center; flex-shrink:0; gap:3px; user-select:none; transform:translateY(-1.5px);">
      <button onclick="window.firePopupNav(-1)"
        style="background:none; border:none; padding:0 4px; font-size:13px; line-height:1; cursor:${prevDisabled ? 'default' : 'pointer'}; color:${prevDisabled ? 'var(--border)' : 'var(--text-dim)'};"
        ${prevDisabled ? 'disabled' : ''}>&#9664;</button>
      <span style="font-size:11px; color:var(--text-dim); font-variant-numeric:tabular-nums; white-space:nowrap; padding-top:2px;">${idx + 1}&thinsp;/&thinsp;${total}</span>
      <button onclick="window.firePopupNav(1)"
        style="background:none; border:none; padding:0 4px; font-size:13px; line-height:1; cursor:${nextDisabled ? 'default' : 'pointer'}; color:${nextDisabled ? 'var(--border)' : 'var(--text-dim)'};"
        ${nextDisabled ? 'disabled' : ''}>&#9654;</button>
    </div>` : '';

  return `
    <div style="border-left:3px solid ${featureColor}; margin:-6px -10px -10px -11px; padding:6px 14px 12px 11px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:3px;">
        <div class="popup-title" style="margin-bottom:0;">${escHtml(name)} Fire</div>
        ${navHtml}
      </div>
      <div class="popup-meta">
        <span class="popup-mode-link" style="color:${decadeColor};" onclick="window.setColorMode('decade')">${year}</span>
        <span class="popup-dot">·</span>
        <span class="popup-mode-link" style="color:${seasonColor};" onclick="window.setColorMode('season')">${season}</span>
        <span class="popup-dot">·</span>
        <span class="popup-mode-link" style="color:${causeColor};" onclick="window.setColorMode('cause')">${cause}</span>
        <span class="popup-dot">·</span>
        <span>${escHtml(agency)}</span>
      </div>
      <hr style="border:0; border-top:1px solid var(--border); margin:6px 0 8px 0;">
      <div class="popup-grid">
        <div class="popup-row">
          <div class="popup-val popup-mode-link" style="color:${sizeColor};" onclick="window.setColorMode('size')">${acres}</div>
        </div>
        <div class="popup-row">
          <div class="popup-val">${dateRange}</div>
        </div>
      </div>
      <div style="margin-top:5px; font-size:10px; color:var(--text-dim); font-weight:500;">
        ${locHtml}
      </div>
    </div>`;
}

function renderFirePopup() {
  const html = buildFirePopupHTML();

  const feat = clickFeatures[clickIndex];
  if (feat && feat.id !== undefined) {
    const sourceId = feat.source || (feat.layer ? feat.layer.source : null);
    if (popupActiveId !== null && (popupActiveId !== feat.id || popupActiveSource !== sourceId)) {
      try {
        map.setFeatureState({ source: popupActiveSource, id: popupActiveId }, { popup: false });
      } catch (err) {}
    }
    popupActiveId = feat.id;
    popupActiveSource = sourceId;
    if (popupActiveSource) {
      try {
        map.setFeatureState({ source: popupActiveSource, id: popupActiveId }, { popup: true });
      } catch (err) {}
    }
  }

  if (currentPopup && currentPopup.isOpen()) {
    currentPopup.setLngLat(currentPopupLngLat).setHTML(html);
  } else {
    if (currentPopup) currentPopup.remove();
    currentPopup = new maplibregl.Popup({
      maxWidth: '420px',
      closeButton: true,
      anchor: 'bottom',
      closeOnClick: false
    })
      .setLngLat(currentPopupLngLat)
      .setHTML(html);

    currentPopup.on('close', () => {
      if (popupActiveId !== null && popupActiveSource) {
        try {
          map.setFeatureState({ source: popupActiveSource, id: popupActiveId }, { popup: false });
        } catch (err) {}
        popupActiveId = null;
        popupActiveSource = null;
      }
    });

    currentPopup.addTo(map);
  }
}

// Global Esc key listener
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && currentPopup) {
    currentPopup.remove();
  }
});

// Global color mode switcher (called from popup links)
window.setColorMode = function (mode) {
  colorMode = mode;
  saveSettings();
  if (dataLoaded) {
    applyFireLayers();
    // Re-render popup in-place so left border + colors update immediately
    if (currentPopup && currentPopup.isOpen() && clickFeatures.length > 0) {
      renderFirePopup();
    }
  }
};

// Global nav handler called by inline button onclick
window.firePopupNav = function (dir) {
  const next = clickIndex + dir;
  if (next < 0 || next >= clickFeatures.length) return;
  clickIndex = next;
  renderFirePopup();
};

// Double-right-click to reset pitch/bearing
let lastRightClick = 0;
map.getCanvas().addEventListener('contextmenu', (e) => {
  const now = Date.now();
  if (now - lastRightClick < 500) {
    e.preventDefault();
    map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
  }
  lastRightClick = now;
});

// Close popup when clicking on empty map area
map.on('click', (e) => {
  const features = map.queryRenderedFeatures(e.point, { layers: ['fires-fill'] });
  if (features.length === 0 && currentPopup && currentPopup.isOpen()) {
    currentPopup.remove();
  }
});

// ---- Utility functions ----
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function acToDisplay(ac) {
  if (currentUnits === 'metric') return ac * 0.404686;
  if (currentUnits === 'sqmi') return ac / 640;
  if (currentUnits === 'sqkm') return ac * 0.00404686;
  return ac; // imperial = acres
}

const UNIT_LABEL = {
  imperial: 'acres',
  metric: 'ha',
  sqmi: 'mi²',
  sqkm: 'km²',
};

function formatAcresValue(ac) {
  const v = acToDisplay(ac);
  if (v === 0) return '0';
  let suffix = '';
  let value = v;
  if (v >= 1000000) {
    value = v / 1000000;
    suffix = 'M';
  } else if (v >= 1000) {
    value = v / 1000;
    suffix = 'K';
  }
  
  let formatted = '';
  if (value >= 100) {
    formatted = value.toFixed(0);
  } else if (value >= 10) {
    formatted = value.toFixed(1);
  } else {
    formatted = value.toFixed(2);
  }
  return formatted + suffix;
}

function formatAcres(ac) {
  const unit = UNIT_LABEL[currentUnits] || 'acres';
  return formatAcresValue(ac) + ' ' + unit;
}

function formatAcresShort(ac) {
  return formatAcres(ac);
}

function formatCount(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function formatDate(s) {
  if (!s) return '—';
  const d = new Date(s + 'T12:00:00Z'); // noon UTC avoids timezone shift
  if (isNaN(d)) return s;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function calcDuration(start, end) {
  if (!start || !end) return null;
  const s = new Date(start), e = new Date(end);
  if (isNaN(s) || isNaN(e)) return null;
  const days = Math.round((e - s) / 86400000);
  if (days < 0 || days > 500) return null;
  if (days === 0) return '< 1 day';
  if (days === 1) return '1 day';
  return `${days} days`;
}



// ---- Legend ----
function updateLegend() {
  const titleEl = document.getElementById('layer-title');
  const itemsEl = document.getElementById('legend-content');
  itemsEl.innerHTML = '';

  if (colorMode === 'decade') {
    titleEl.textContent = 'Year';
    const gradColors = YEAR_COLOR_STOPS.map(([, c]) => c).join(', ');
    const minY = YEAR_COLOR_STOPS[0][0];
    const maxY = YEAR_COLOR_STOPS[YEAR_COLOR_STOPS.length - 1][0];
    itemsEl.innerHTML = `
      <div style="width:100%; height:10px; border-radius:3px; background:linear-gradient(to right, ${gradColors}); margin-bottom:4px;"></div>
      <div style="display:flex; justify-content:space-between; font-size:9px; color:var(--text-dim);">
        <span>${minY}</span><span>${maxY}</span>
      </div>`;
  } else if (colorMode === 'cause') {
    titleEl.textContent = 'Cause';
    const topCauses = [[1, 'Lightning'], [7, 'Arson'], [2, 'Equipment'], [5, 'Debris'], [4, 'Campfire'], [11, 'Power Line'], [14, 'Unknown']];
    for (const [id, label] of topCauses) {
      itemsEl.innerHTML += `<div class="legend-row"><span class="legend-swatch" style="background:${CAUSE_COLORS[id]}"></span>${label}</div>`;
    }
  } else if (colorMode === 'size') {
    titleEl.textContent = 'Size';
    const gradColors = SIZE_COLOR_STOPS.map(([, c]) => c).join(', ');
    itemsEl.innerHTML = `
      <div style="width:100%; height:10px; border-radius:3px; background:linear-gradient(to right, ${gradColors}); margin-bottom:4px;"></div>
      <div style="display:flex; justify-content:space-between; font-size:9px; color:var(--text-dim);">
        <span>0</span><span>500K+ acres</span>
      </div>`;
  } else if (colorMode === 'season') {
    titleEl.textContent = 'Season';
    for (const [season, color] of Object.entries(SEASON_COLORS)) {
      itemsEl.innerHTML += `<div class="legend-row"><span class="legend-swatch" style="background:${color}"></span>${season}</div>`;
    }
  }
}


const STATE_BOUNDS = {
  CA: [[-124.48, 32.53], [-114.13, 42.01]],
  AK: [[-179.15, 51.21], [-129.98, 71.39]],
  AZ: [[-114.82, 31.33], [-109.04, 37.0]],
  CO: [[-109.06, 36.99], [-102.04, 41.0]],
  ID: [[-117.24, 41.99], [-111.04, 49.0]],
  MT: [[-116.05, 44.36], [-104.04, 49.0]],
  NV: [[-120.01, 35.0], [-114.04, 42.0]],
  NM: [[-109.05, 31.33], [-103.0, 37.0]],
  OR: [[-124.65, 41.99], [-116.46, 46.29]],
  UT: [[-114.05, 37.0], [-109.04, 42.0]],
  WA: [[-124.85, 45.54], [-116.92, 49.0]],
  WY: [[-111.05, 41.0], [-104.05, 45.0]]
};



function updateBorders() {
  const mode = document.getElementById('borders-select').value;
  currentBorders = mode;
  saveSettings();

  if (!map.getSource('borders-source')) {
    map.addSource('borders-source', {
      type: 'geojson',
      data: './borders.json'
    });
  }
  if (!map.getSource('state-borders-source')) {
    map.addSource('state-borders-source', {
      type: 'geojson',
      data: './borders_state.json'
    });
  }

  const borderColor = '#000000';
  const borderOpacity = 1.0;
  const stateBorderColor = '#000000';
  const stateBorderOpacity = 0.5;

  // Handle National Borders
  if (mode === 'national' || mode === 'state') {
    if (!map.getLayer('borders-layer')) {
      map.addLayer({
        id: 'borders-layer',
        type: 'line',
        source: 'borders-source',
        paint: {
          'line-color': borderColor,
          'line-width': 1.0,
          'line-opacity': borderOpacity
        }
      });
    } else {
      map.setLayoutProperty('borders-layer', 'visibility', 'visible');
      map.setPaintProperty('borders-layer', 'line-color', borderColor);
      map.setPaintProperty('borders-layer', 'line-opacity', borderOpacity);
    }
    map.moveLayer('borders-layer'); // Enforce top layering
  } else {
    if (map.getLayer('borders-layer')) map.setLayoutProperty('borders-layer', 'visibility', 'none');
  }

  // Handle State Borders
  if (mode === 'state') {
    if (!map.getLayer('state-borders-layer')) {
      map.addLayer({
        id: 'state-borders-layer',
        type: 'line',
        source: 'state-borders-source',
        paint: {
          'line-color': stateBorderColor,
          'line-width': 0.75,
          'line-opacity': stateBorderOpacity
        }
      });
    } else {
      map.setLayoutProperty('state-borders-layer', 'visibility', 'visible');
      map.setPaintProperty('state-borders-layer', 'line-color', stateBorderColor);
      map.setPaintProperty('state-borders-layer', 'line-opacity', stateBorderOpacity);
    }
    if (map.getLayer('borders-layer')) {
      map.moveLayer('state-borders-layer', 'borders-layer');
    } else {
      map.moveLayer('state-borders-layer');
    }
  } else {
    if (map.getLayer('state-borders-layer')) map.setLayoutProperty('state-borders-layer', 'visibility', 'none');
  }
}

function processFeatures(features) {
  for (let i = 0; i < features.length; i++) {
    const props = features[i].properties;
    if (props) {
      const ad = props.ad;
      let se = 4; // Default to Winter (4)
      if (ad && ad.length >= 7) {
        const m = parseInt(ad.slice(5, 7), 10);
        if (m >= 3 && m <= 5) se = 1;      // Spring
        else if (m >= 6 && m <= 8) se = 2; // Summer
        else if (m >= 9 && m <= 11) se = 3;// Fall
      }
      props.se = se;
    }
  }
}

function loadInitialData() {
  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = 'Loading low-res overview…';

  dataLoaded = false;
  highResLoaded = false;
  loadedStates = {};
  highResFeatures = [];

  // 1. Fetch low-res overview
  fetch('./fires_lowres.geojson')
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(geojson => {
      const features = geojson.features || [];
      processFeatures(features);
      
      // Populate allFeatures immediately for stats & search
      allFeatures = features;
      dataLoaded = true;

      // Add low-res source and layers
      if (!map.getSource('fires-lowres-source')) {
        map.addSource('fires-lowres-source', {
          type: 'geojson',
          data: geojson,
          generateId: true,
          tolerance: 0
        });

        const colorExpr = buildColorExpression();
        const filterExpr = buildMapFilter();

        map.addLayer({
          id: 'fires-fill-lowres',
          type: 'fill',
          source: 'fires-lowres-source',
          maxzoom: 7,
          filter: filterExpr,
          paint: {
            'fill-color': colorExpr,
            'fill-opacity': ['case',
              ['any', ['boolean', ['feature-state', 'hover'], false], ['boolean', ['feature-state', 'popup'], false]],
              Math.min(opacityVal + 0.35, 1.0),
              opacityVal * 0.75
            ],
            'fill-antialias': true
          }
        });

        map.addLayer({
          id: 'fires-outline-lowres',
          type: 'line',
          source: 'fires-lowres-source',
          maxzoom: 7,
          filter: filterExpr,
          paint: {
            'line-color': colorExpr,
            'line-width': ['interpolate', ['linear'], ['zoom'],
              5, 0.3,
              7, 0.6
            ],
            'line-opacity': 1.0
          }
        });

        setupFireLayerEvents('fires-fill-lowres', 'fires-lowres-source');
      }

      // Add empty high-res source (initially empty) and layers
      if (!map.getSource('fires-source')) {
        map.addSource('fires-source', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          generateId: true,
          tolerance: 0
        });

        const colorExpr = buildColorExpression();
        const filterExpr = buildMapFilter();

        map.addLayer({
          id: 'fires-fill',
          type: 'fill',
          source: 'fires-source',
          minzoom: 7,
          filter: filterExpr,
          paint: {
            'fill-color': colorExpr,
            'fill-opacity': ['case',
              ['any', ['boolean', ['feature-state', 'hover'], false], ['boolean', ['feature-state', 'popup'], false]],
              Math.min(opacityVal + 0.35, 1.0),
              opacityVal * 0.75
            ],
            'fill-antialias': true
          }
        });

        map.addLayer({
          id: 'fires-outline',
          type: 'line',
          source: 'fires-source',
          minzoom: 7,
          filter: filterExpr,
          paint: {
            'line-color': colorExpr,
            'line-width': ['interpolate', ['linear'], ['zoom'],
              7, 0.6,
              9, 0.8,
              12, 1.2
            ],
            'line-opacity': 1.0
          }
        });

        setupFireLayerEvents('fires-fill', 'fires-source');
      }

      applyFireLayers();
    })
    .catch(err => {
      console.error('Error loading data:', err);
      if (statusEl && !dataLoaded) {
        statusEl.textContent = 'Error loading fires';
      }
    });
}

// ---- Main map load ----
map.on('load', () => {
  map.addLayer({ id: 'overlay-anchor', type: 'background', paint: { 'background-opacity': 0 } });

  setupBasemap(currentBasemap);
  setupProjection(currentProjection);

  // Sync UI with loaded settings
  document.getElementById('year-min').value = activeFilters.yearMin;
  document.getElementById('year-max').value = activeFilters.yearMax;
  document.getElementById('cause-filter').value = activeFilters.cause;
  document.getElementById('size-filter').value = activeFilters.size > 0 ? (activeFilters.size / (currentUnits === 'metric' ? 1 / 0.404686 : 1)).toFixed(0) : '';
  document.getElementById('basemap').value = currentBasemap;
  document.getElementById('projection-select').value = currentProjection;
  document.getElementById('borders-select').value = currentBorders;
  document.getElementById('units-select').value = currentUnits;
  document.getElementById('opacity-slider').value = opacityVal * 100;
  document.getElementById('theme-select').value = document.body.classList.contains('light-mode') ? 'light' : 'dark';
  document.getElementById('terrain-select').value = terrainMode;
  document.getElementById('terrain-exaggeration').value = terrainExaggeration;

  setupTerrain(terrainMode, terrainExaggeration);

  updateBorders();
  loadInitialData();
});

document.getElementById('projection-select').addEventListener('change', e => {
  setupProjection(e.target.value);
  saveSettings();
});

document.getElementById('borders-select').addEventListener('change', updateBorders);

// ---- Filter event listeners ----
function applyYearFilter() {
  const minEl = document.getElementById('year-min');
  const maxEl = document.getElementById('year-max');
  const minY = parseInt(minEl.value) || 1870;
  const maxY = parseInt(maxEl.value) || 2025;
  activeFilters.yearMin = Math.min(minY, maxY);
  activeFilters.yearMax = Math.max(minY, maxY);
  updateHash();
  if (dataLoaded) applyFireLayers();
}

document.getElementById('year-min').addEventListener('change', applyYearFilter);
document.getElementById('year-max').addEventListener('change', applyYearFilter);

document.getElementById('cause-filter').addEventListener('change', e => {
  activeFilters.cause = e.target.value;
  updateHash();
  if (dataLoaded) applyFireLayers();
});

document.getElementById('size-filter').addEventListener('input', e => {
  // value is always in acres; when metric, user types ha and we convert
  const raw = parseFloat(e.target.value);
  if (isNaN(raw) || e.target.value === '') {
    activeFilters.size = 0;
  } else {
    // Convert displayed unit back to acres for internal comparison
    const toAcres = { imperial: 1, metric: 1 / 0.404686, sqmi: 640, sqkm: 1 / 0.00404686 };
    activeFilters.size = raw * (toAcres[currentUnits] || 1);
  }
  updateHash();
  if (dataLoaded) applyFireLayers();
});

document.getElementById('basemap').addEventListener('change', e => {
  setupBasemap(e.target.value);
  saveSettings();
});



document.getElementById('opacity-slider').addEventListener('input', e => {
  opacityVal = parseInt(e.target.value) / 100;

  const opacityExpr = ['case',
    ['any', ['boolean', ['feature-state', 'hover'], false], ['boolean', ['feature-state', 'popup'], false]],
    Math.min(opacityVal + 0.35, 1.0),
    opacityVal * 0.75
  ];

  if (map.getLayer('fires-fill-lowres')) {
    map.setPaintProperty('fires-fill-lowres', 'fill-opacity', opacityExpr);
  }
  if (map.getLayer('fires-fill')) {
    map.setPaintProperty('fires-fill', 'fill-opacity', opacityExpr);
  }
});

document.getElementById('opacity-slider').addEventListener('change', () => {
  saveSettings();
});

document.getElementById('opacity-row').addEventListener('wheel', e => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? -5 : 5;
  const slider = document.getElementById('opacity-slider');
  slider.value = Math.min(100, Math.max(0, parseInt(slider.value) + delta));
  slider.dispatchEvent(new Event('input'));
});

document.getElementById('units-select').addEventListener('change', e => {
  currentUnits = e.target.value;
  saveSettings();
  // Update size-filter placeholder
  document.getElementById('size-filter').placeholder =
    currentUnits === 'metric' ? 'min size (ha)' : 'min size';
  if (dataLoaded) applyFireLayers();
});

document.getElementById('theme-select').addEventListener('change', e => {
  document.body.classList.toggle('light-mode', e.target.value === 'light');
  saveSettings();
});

document.getElementById('terrain-select').addEventListener('change', e => {
  setupTerrain(e.target.value, terrainExaggeration);
  saveSettings();
});

document.getElementById('terrain-exaggeration').addEventListener('input', e => {
  const val = parseFloat(e.target.value);
  if (!isNaN(val)) {
    setupTerrain(terrainMode, val);
    saveSettings();
  }
});

// ---- Settings and Search dropdowns ----
document.addEventListener('click', e => {
  const searchResults = document.getElementById('search-results');
  const searchInput = document.getElementById('location-search');
  if (searchResults && searchInput && !searchInput.contains(e.target) && !searchResults.contains(e.target)) {
    searchResults.style.display = 'none';
  }
});

window.toggleSettings = (e) => {
  e.stopPropagation();
  document.getElementById('settings-menu').classList.toggle('show');
};

window.addEventListener('click', () => {
  const menu = document.getElementById('settings-menu');
  if (menu) menu.classList.remove('show');
});

document.getElementById('settings-menu').addEventListener('click', (e) => e.stopPropagation());

// ---- Search Feature ----
function getGeometryCenter(geometry) {
  if (!geometry) return null;
  let coords = [];
  if (geometry.type === 'Point') {
    coords = [geometry.coordinates];
  } else if (geometry.type === 'MultiPoint' || geometry.type === 'LineString') {
    coords = geometry.coordinates;
  } else if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') {
    coords = geometry.coordinates.flat(1);
  } else if (geometry.type === 'MultiPolygon') {
    coords = geometry.coordinates.flat(2);
  }
  if (coords.length === 0) return null;

  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const c of coords) {
    if (Array.isArray(c) && c.length >= 2) {
      const lng = c[0], lat = c[1];
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return {
    lng: (minLng + maxLng) / 2,
    lat: (minLat + maxLat) / 2,
    bounds: [[minLng, minLat], [maxLng, maxLat]]
  };
}

function searchFires(query) {
  const matches = [];
  const lowerQuery = query.toLowerCase();
  for (const f of allFeatures) {
    if (f.properties && f.properties.n) {
      if (f.properties.n.toLowerCase().includes(lowerQuery)) {
        matches.push(f);
      }
    }
  }
  // Sort by acres descending
  matches.sort((a, b) => (b.properties.ac || 0) - (a.properties.ac || 0));
  return matches.slice(0, 5);
}

function searchPlaces(query, callback) {
  fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`)
    .then(r => r.json())
    .then(data => callback(data))
    .catch(err => {
      console.error('Place search failed:', err);
      callback([]);
    });
}

function renderSearchResults(fires, places) {
  const searchResults = document.getElementById('search-results');
  const searchInput = document.getElementById('location-search');
  let html = '';

  if (fires.length > 0) {
    html += `<div class="search-results-section-header">Fires</div>`;
    fires.forEach((f, idx) => {
      const name = f.properties.n || 'Unnamed';
      const year = f.properties.y || '';
      const acresVal = f.properties.ac || 0;
      
      const valueText = formatAcresValue(acresVal);
      const unit = UNIT_LABEL[currentUnits] || 'acres';

      const yearColor = interpolateColor(YEAR_COLOR_STOPS, year);
      const sizeColor = interpolateColor(SIZE_COLOR_STOPS, acresVal);

      const yearSpan = year ? `<span style="color:${yearColor}; font-weight:600;">${year}</span>` : '';
      const sizeSpan = acresVal ? `<span style="color:${sizeColor}; font-weight:600;">${valueText}</span> <span style="color:var(--text-dim);">${unit}</span>` : '';
      const separator = (year && acresVal) ? ` <span style="color:var(--text-dim);">·</span> ` : '';
      const desc = `${yearSpan}${separator}${sizeSpan}`;

      html += `
        <div class="search-result-item" data-type="fire" data-index="${idx}">
          <strong>${escHtml(name)} Fire</strong>
          <span style="font-size:10px;">${desc}</span>
        </div>
      `;
    });
  }

  if (places.length > 0) {
    html += `<div class="search-results-section-header">Places</div>`;
    places.forEach((p, idx) => {
      html += `
        <div class="search-result-item" data-type="place" data-lat="${p.lat}" data-lon="${p.lon}">
          <span>${escHtml(p.display_name)}</span>
        </div>
      `;
    });
  }

  if (fires.length === 0 && places.length === 0) {
    html = `<div style="padding: 10px 12px; font-size:12px; color:var(--text-dim);">No results found</div>`;
  }

  searchResults.innerHTML = html;
  searchResults.style.display = 'flex';

  const items = searchResults.querySelectorAll('.search-result-item');
  items.forEach(item => {
    item.addEventListener('click', () => {
      const type = item.getAttribute('data-type');
      if (type === 'fire') {
        const idx = parseInt(item.getAttribute('data-index'));
        const feat = fires[idx];
        const center = getGeometryCenter(feat.geometry);
        if (center) {
          if (center.bounds) {
            map.fitBounds(center.bounds, { padding: 40, maxZoom: 14 });
          } else {
            map.flyTo({ center: [center.lng, center.lat], zoom: 12 });
          }

          clickFeatures = [feat];
          clickIndex = 0;
          currentPopupLngLat = new maplibregl.LngLat(center.lng, center.lat);
          currentCounty = '';
          renderFirePopup();

          fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${center.lat}&lon=${center.lng}&zoom=10`)
            .then(r => r.json())
            .then(data => {
              if (data && data.address && data.address.county) {
                currentCounty = data.address.county;
                if (currentPopup && currentPopup.isOpen()) renderFirePopup();
              }
            })
            .catch(() => { });
        }
      } else if (type === 'place') {
        const lat = parseFloat(item.getAttribute('data-lat'));
        const lon = parseFloat(item.getAttribute('data-lon'));
        map.flyTo({ center: [lon, lat], zoom: 10 });
      }

      searchResults.style.display = 'none';
      searchInput.value = '';
    });
  });
}

let searchTimeout = null;
const searchInput = document.getElementById('location-search');
const searchResults = document.getElementById('search-results');

if (searchInput) {
  searchInput.addEventListener('input', e => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    if (q.length < 2) {
      searchResults.innerHTML = '';
      searchResults.style.display = 'none';
      return;
    }

    searchTimeout = setTimeout(() => {
      const matchedFires = searchFires(q);
      searchPlaces(q, (matchedPlaces) => {
        renderSearchResults(matchedFires, matchedPlaces);
      });
    }, 350);
  });

  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const firstResult = searchResults.querySelector('.search-result-item');
      if (firstResult) {
        firstResult.click();
      }
    }
  });
}


