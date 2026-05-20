// CALIFORNIA FIRE HISTORY VISUALIZER — app.js
maplibregl.prewarm();
maplibregl.workerCount = Math.max(2, navigator.hardwareConcurrency || 2);

// ---- Global State ----
let allFeatures = [];       // raw GeoJSON features
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
let terrainEnabled = false;
let terrainExaggeration = 1.5;

// ---- Settings Persistence ----
function saveSettings() {
  const settings = {
    units: currentUnits,
    basemap: currentBasemap,
    opacity: opacityVal,
    colorMode: colorMode,
    terrain: terrainEnabled,
    exaggeration: terrainExaggeration,
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
      if (s.terrain !== undefined) terrainEnabled = s.terrain;
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
  1870: '#4a1942', 1890: '#6b2d5e', 1900: '#8b3a76',
  1910: '#a84090', 1920: '#c44daa', 1930: '#d45a9a',
  1940: '#e06a80', 1950: '#e87c60',
  1960: '#f08040', 1970: '#f59030',
  1980: '#f9a020', 1990: '#fcb015',
  2000: '#fd8c0a', 2010: '#fd5c0a', 2020: '#ff2200'
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
  [0, '#ffe066'], [100, '#ffcc00'], [1000, '#ffa500'],
  [10000, '#ff8800'], [50000, '#ff5500'], [100000, '#ff3300'], [500000, '#ff0000']
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
  const season = getSeason(props.ad);

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
  center: [-119.5, 37.3],
  zoom: 5.5,
  maxZoom: 16,
  minZoom: 4,
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
map.on('moveend', updateHash);

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
  }, 'fires-fill' in map.style._layers ? 'fires-fill' : undefined);

  currentBasemap = id;
}

// ---- 3D Terrain ----
function setupTerrain(enable, exaggeration = terrainExaggeration) {
  if (enable) {
    if (!map.getSource('terrain-source')) {
      map.addSource('terrain-source', {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 15
      });
    }

    // 3D Elevation
    map.setTerrain({ source: 'terrain-source', exaggeration: parseFloat(exaggeration) });

    // Hillshading for visual depth
    if (!map.getLayer('hillshade-layer')) {
      map.addLayer({
        id: 'hillshade-layer',
        type: 'hillshade',
        source: 'terrain-source',
        paint: {
          'hillshade-exaggeration': 0.6,
          'hillshade-shadow-color': '#000',
          'hillshade-highlight-color': '#fff',
          'hillshade-accent-color': '#000'
        }
      }, map.getLayer('basemap-layer') ? 'basemap-layer' : undefined);
      // Wait, we want hillshade ABOVE basemap? Usually yes.
      // If we put it before 'basemap-layer', it's below it.
      // If we omit second arg, it's at the top (above fires).
      // We want it between basemap and fires.
      if (map.getLayer('basemap-layer') && map.getLayer('fires-fill')) {
        map.moveLayer('hillshade-layer', 'fires-fill');
      }
    } else {
      map.setLayoutProperty('hillshade-layer', 'visibility', 'visible');
    }
  } else {
    map.setTerrain(null);
    if (map.getLayer('hillshade-layer')) {
      map.setLayoutProperty('hillshade-layer', 'visibility', 'none');
    }
  }
  terrainEnabled = enable;
  terrainExaggeration = parseFloat(exaggeration);
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
    const label = isFiltered ? 'Filtered' : 'All fires';
    statusEl.textContent = `${label} · ${formatCount(filteredCount)} shown`;
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
    base = ['case',
      ['all', ['!=', ['get', 'ad'], ''], ['>=', ['to-number', ['slice', ['get', 'ad'], 5, 7]], 3], ['<=', ['to-number', ['slice', ['get', 'ad'], 5, 7]], 5]],
      '#81c784',
      ['all', ['!=', ['get', 'ad'], ''], ['>=', ['to-number', ['slice', ['get', 'ad'], 5, 7]], 6], ['<=', ['to-number', ['slice', ['get', 'ad'], 5, 7]], 8]],
      '#ff8f00',
      ['all', ['!=', ['get', 'ad'], ''], ['>=', ['to-number', ['slice', ['get', 'ad'], 5, 7]], 9], ['<=', ['to-number', ['slice', ['get', 'ad'], 5, 7]], 11]],
      '#e53935',
      '#7986cb'
    ];
  } else {
    base = '#ff5c1a';
  }

  // Return base for outlines, but for fills we can use a hover check if we want
  return base;
}

// ---- Apply layers ----
function applyFireLayers() {
  updateStats();
  const colorExpr = buildColorExpression();
  const filterExpr = buildMapFilter();

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
  } else {
    map.addSource('fires-source', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: allFeatures },
      generateId: true
    });

    // Base fill
    map.addLayer({
      id: 'fires-fill',
      type: 'fill',
      source: 'fires-source',
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

    // Outline layer
    map.addLayer({
      id: 'fires-outline',
      type: 'line',
      source: 'fires-source',
      filter: filterExpr,
      paint: {
        'line-color': colorExpr,
        'line-width': ['interpolate', ['linear'], ['zoom'],
          5, 0.3,
          9, 0.8,
          12, 1.2
        ],
        'line-opacity': ['case',
          ['any', ['boolean', ['feature-state', 'hover'], false], ['boolean', ['feature-state', 'popup'], false]],
          1.0, 0.6
        ]
      }
    });
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
let popupActiveId = null;

map.on('mousemove', 'fires-fill', (e) => {
  map.getCanvas().style.cursor = 'pointer';
  if (e.features && e.features.length > 0) {
    // Highlight the smallest fire (lowest acres)
    const sorted = e.features.slice().sort((a, b) => (a.properties.ac || 0) - (b.properties.ac || 0));
    const topFeature = sorted[0];

    if (hoveredId !== null && hoveredId !== topFeature.id) {
      map.setFeatureState({ source: 'fires-source', id: hoveredId }, { hover: false });
    }
    hoveredId = topFeature.id;
    map.setFeatureState({ source: 'fires-source', id: hoveredId }, { hover: true });
  }
});

map.on('mouseleave', 'fires-fill', () => {
  if (!map.isMoving()) map.getCanvas().style.cursor = 'grab';
  if (hoveredId !== null) {
    map.setFeatureState({ source: 'fires-source', id: hoveredId }, { hover: false });
  }
  hoveredId = null;
});

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
  const season = getSeason(props.ad);
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

  // Nav arrows — horizontal, pushed to the right side
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

  // Update dedicated popup highlight state
  const feat = clickFeatures[clickIndex];
  if (feat && feat.id !== undefined) {
    if (popupActiveId !== null && popupActiveId !== feat.id) {
      map.setFeatureState({ source: 'fires-source', id: popupActiveId }, { popup: false });
    }
    popupActiveId = feat.id;
    map.setFeatureState({ source: 'fires-source', id: popupActiveId }, { popup: true });
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
      if (popupActiveId !== null) {
        map.setFeatureState({ source: 'fires-source', id: popupActiveId }, { popup: false });
        popupActiveId = null;
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

// ---- Click popup ----
map.on('click', 'fires-fill', (e) => {
  if (!e.features || e.features.length === 0) return;

  // Sort by acres ascending (smallest first), break ties by year descending
  clickFeatures = e.features.slice().sort((a, b) =>
    (a.properties.ac || 0) - (b.properties.ac || 0) ||
    (b.properties.y || 0) - (a.properties.y || 0)
  );
  clickIndex = 0;
  currentPopupLngLat = e.lngLat;
  currentCounty = '';

  // Fetch county via reverse geocoding
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

function formatAcres(ac) {
  const v = acToDisplay(ac);
  const unit = UNIT_LABEL[currentUnits] || 'acres';
  if (v >= 1000000) return (v / 1000000).toFixed(2) + 'M ' + unit;
  if (v >= 1000) return (v / 1000).toFixed(1) + 'K ' + unit;
  return Math.round(v).toLocaleString() + ' ' + unit;
}

function formatAcresShort(ac) {
  const v = acToDisplay(ac);
  const unit = UNIT_LABEL[currentUnits] || 'acres';
  if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M ' + unit;
  if (v >= 1000) return Math.round(v / 1000) + 'K ' + unit;
  return Math.round(v).toLocaleString() + ' ' + unit;
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


// ---- Main map load ----
map.on('load', () => {
  map.addLayer({ id: 'bottom-anchor', type: 'background', paint: { 'background-opacity': 0 } });

  setupBasemap(currentBasemap);

  // Sync UI with loaded settings
  document.getElementById('year-min').value = activeFilters.yearMin;
  document.getElementById('year-max').value = activeFilters.yearMax;
  document.getElementById('cause-filter').value = activeFilters.cause;
  document.getElementById('size-filter').value = activeFilters.size > 0 ? (activeFilters.size / (currentUnits === 'metric' ? 1 / 0.404686 : 1)).toFixed(0) : '';
  document.getElementById('basemap').value = currentBasemap;
  document.getElementById('units-select').value = currentUnits;
  document.getElementById('opacity-slider').value = opacityVal * 100;
  document.getElementById('theme-select').value = document.body.classList.contains('light-mode') ? 'light' : 'dark';
  document.getElementById('hillshade-check').checked = terrainEnabled;
  document.getElementById('terrain-exaggeration').value = terrainExaggeration;

  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = 'Loading data…';

  setupTerrain(terrainEnabled, terrainExaggeration);

  fetch('./fires.geojson')
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(geojson => {
      allFeatures = geojson.features || [];
      dataLoaded = true;
      applyFireLayers();
      updateStats();
    })
    .catch(err => {
      console.error('Failed to load fires.geojson:', err);
      if (statusEl) statusEl.textContent = 'Error loading data';
    });
});

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
  saveSettings();
  if (map.getLayer('fires-fill')) {
    map.setPaintProperty('fires-fill', 'fill-opacity', ['case',
      ['boolean', ['feature-state', 'hover'], false],
      Math.min(opacityVal + 0.15, 1.0),
      opacityVal * 0.75
    ]);
  }
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

document.getElementById('hillshade-check').addEventListener('change', e => {
  setupTerrain(e.target.checked, terrainExaggeration);
  saveSettings();
});

document.getElementById('terrain-exaggeration').addEventListener('input', e => {
  const val = parseFloat(e.target.value);
  if (!isNaN(val)) {
    setupTerrain(terrainEnabled, val);
    saveSettings();
  }
});

// ---- Settings dropdown ----
document.addEventListener('click', e => {
  const menu = document.getElementById('settings-menu');
  const btn = document.getElementById('settings-btn');
  if (!btn.contains(e.target) && !menu.contains(e.target)) {
    menu.style.display = 'none';
  }
});

window.toggleSettings = function (e) {
  e.stopPropagation();
  const menu = document.getElementById('settings-menu');
  const isShown = menu.style.display === 'flex';
  menu.style.display = isShown ? 'none' : 'flex';
  menu.style.flexDirection = 'column';
  menu.style.gap = '10px';
};


