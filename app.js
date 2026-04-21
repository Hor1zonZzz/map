import {
  createAmapUrl,
  formatCoords,
  pickRandomImpactLngLat,
  pickRegionForCurrentDepth,
  projectLngLatToScreen,
  resolveDestination,
} from './src/destination-core.mjs';

// 华夏舆图 · 行政区划下钻版
(function () {
  'use strict';

  const d3 = window.d3;
  const turf = window.turf;
  if (!d3 || !turf) {
    throw new Error('地图运行依赖缺失：需要先加载 d3 与 turf');
  }

  const geoOps = {
    bbox: turf.bbox,
    point: turf.point,
    booleanPointInPolygon: turf.booleanPointInPolygon,
    pointOnFeature: turf.pointOnFeature,
  };

  const TWEAKS = /*EDITMODE-BEGIN*/{
    "colorTheme": "vintage"
  }/*EDITMODE-END*/;

  const THEMES = {
    vintage: {
      surfaces: ['#d7c39c', '#c89f68', '#b5724a', '#8f9551', '#6f8890', '#a33a2a'],
      neutral: '#c4b18b',
    },
    ink: {
      surfaces: ['#d6cfbf', '#b4a78d', '#8b7a5e', '#6f6657', '#5f736f', '#2a2117'],
      neutral: '#b8ab93',
    },
    autumn: {
      surfaces: ['#dcc28f', '#d79b4f', '#c56a2a', '#ab7d3a', '#8f5f2e', '#8a2818'],
      neutral: '#cfb07d',
    },
  };

  const ROOT_CODE = '100000';
  const MAX_DEPTH = 2;
  const LEVEL_LABELS = {
    province: '省级单位',
    city: '市级单位',
    district: '区县单位',
  };
  const CARD_LEVEL_LABELS = {
    province: '省级',
    city: '市级',
    district: '区县级',
  };

  const boundaryCache = window.__BOUNDARY_DATA__ || (window.__BOUNDARY_DATA__ = Object.create(null));
  const boundaryPromises = new Map();
  const manifest = window.__BOUNDARY_MANIFEST__ || null;
  const statScheme = window.__STATISTICAL_REGION_SCHEME__ || null;
  const poiShardCache = window.__POI_SHARDS__ || (window.__POI_SHARDS__ = Object.create(null));
  const poiShardPromises = new Map();
  const poiManifest = window.__POI_MANIFEST__ || null;
  const STAT_ORDER = statScheme ? statScheme.regionOrder.concat(['excluded']) : [];
  const STAT_META = statScheme ? {
    ...statScheme.regions,
    excluded: { key: 'excluded', name: '未纳入口径', provinceCodes: Object.keys(statScheme.excludedProvinceMap || {}) },
  } : {};

  const state = {
    scale: 1,
    tx: 0,
    ty: 0,
    targetScale: 1,
    targetTx: 0,
    targetTy: 0,
    stack: [{ code: ROOT_CODE, name: '全国' }],
    currentData: null,
    regions: [],
    darts: [],
    continuousFire: false,
    finalDestination: null,
    destinationStatus: '',
    regionFilter: STAT_ORDER.reduce((acc, k) => { acc[k] = true; return acc; }, {}),
    radiusTool: {
      placing: false,
      radiusKm: 300,
      anchorLngLat: null,
      anchorScreen: null,
      matchedCodes: [],
    },
  };

  let rafHandle = null;
  function renderLoop() {
    const ds = state.targetScale - state.scale;
    const dx = state.targetTx - state.tx;
    const dy = state.targetTy - state.ty;
    if (Math.abs(ds) < 0.0005 && Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) {
      state.scale = state.targetScale;
      state.tx = state.targetTx;
      state.ty = state.targetTy;
      applyTransform();
      rafHandle = null;
      return;
    }
    const k = 0.38;
    state.scale += ds * k;
    state.tx += dx * k;
    state.ty += dy * k;
    applyTransform();
    rafHandle = requestAnimationFrame(renderLoop);
  }
  function scheduleRender() {
    if (rafHandle == null) rafHandle = requestAnimationFrame(renderLoop);
  }

  function statGroupFor(adcode) {
    if (!statScheme) return null;
    const mapped = statScheme.provinceMap[adcode];
    if (mapped) return mapped.regionKey;
    if (statScheme.excludedProvinceMap[adcode]) return 'excluded';
    return null;
  }

  const MAP = document.getElementById('map-svg');
  const stage = document.getElementById('map-stage');
  const wrap = document.getElementById('map-wrap');
  const loadingEl = document.getElementById('map-loading');
  const infoCard = document.getElementById('info-card');
  const destinationCard = document.getElementById('destination-card');
  const scopeNameEl = document.getElementById('scope-name');
  const scopeMetaEl = document.getElementById('scope-meta');
  const scopeCountEl = document.getElementById('scope-count');
  const dataSourceEl = document.getElementById('data-source');
  const breadcrumbEl = document.getElementById('breadcrumb');
  const legendEl = document.getElementById('legend');
  const goUpBtn = document.getElementById('go-up');
  const goHomeBtn = document.getElementById('go-home');
  const tweaksToggle = document.getElementById('tweaks-toggle');
  const dartLayer = document.getElementById('dart-layer');
  const fireDartBtn = document.getElementById('fire-dart');
  const continuousFireBtn = document.getElementById('continuous-fire');
  const stopFireBtn = document.getElementById('stop-fire');
  const clearDartsBtn = document.getElementById('clear-darts');
  const radiusToolEl = document.getElementById('radius-tool');

  let projection = d3.geoMercator();

  function showLoading(on, msg) {
    if (!loadingEl) return;
    if (on) {
      loadingEl.classList.remove('hidden');
      loadingEl.classList.remove('error');
      if (msg) loadingEl.querySelector('.loading-text').textContent = msg;
    } else {
      loadingEl.classList.add('hidden');
    }
  }

  function showError(msg) {
    if (!loadingEl) return;
    loadingEl.classList.remove('hidden');
    loadingEl.classList.add('error');
    loadingEl.querySelector('.loading-text').textContent = msg;
  }

  function currentDepth() {
    return Math.max(0, state.stack.length - 1);
  }

  function currentTheme() {
    return THEMES[TWEAKS.colorTheme] || THEMES.vintage;
  }

  function applyTransform() {
    wrap.style.transform =
      `translate(calc(-50% + ${state.tx}px), calc(-50% + ${state.ty}px)) scale(${state.scale})`;
    wrap.style.setProperty('--zoom', state.scale);
    document.getElementById('zoom-level').textContent = Math.round(state.scale * 100) + '%';
  }

  function resetTransform() {
    state.scale = 1;
    state.tx = 0;
    state.ty = 0;
    state.targetScale = 1;
    state.targetTx = 0;
    state.targetTy = 0;
    if (rafHandle != null) { cancelAnimationFrame(rafHandle); rafHandle = null; }
    applyTransform();
  }

  function snapTransform() {
    state.scale = state.targetScale;
    state.tx = state.targetTx;
    state.ty = state.targetTy;
    if (rafHandle != null) { cancelAnimationFrame(rafHandle); rafHandle = null; }
    applyTransform();
  }

  function persist() {
    try {
      window.parent.postMessage({
        type: '__edit_mode_set_keys',
        edits: { ...TWEAKS },
      }, '*');
    } catch (error) {
      console.warn(error);
    }
  }

  function formatTime(isoText) {
    if (!isoText) return '未知时间';
    const date = new Date(isoText);
    if (Number.isNaN(date.getTime())) return isoText;
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function hashCode(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function darken(hex, amount) {
    const match = hex.replace('#', '').match(/../g);
    if (!match) return hex;
    const [r, g, b] = match.map((item) => parseInt(item, 16));
    const scale = (value) => Math.max(0, Math.floor(value * (1 - amount)))
      .toString(16)
      .padStart(2, '0');
    return `#${scale(r)}${scale(g)}${scale(b)}`;
  }

  function haversineKm(a, b) {
    const [lng1, lat1] = a;
    const [lng2, lat2] = b;
    const toRad = (deg) => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const rLat1 = toRad(lat1);
    const rLat2 = toRad(lat2);
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function pointsToPath(points) {
    if (!points.length) return '';
    return 'M' + points.map((point) => `${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(' L') + ' Z';
  }

  function multiPointsToPath(rings) {
    return rings.map(pointsToPath).join(' ');
  }

  function perpDist(point, start, end) {
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    if (dx === 0 && dy === 0) {
      return Math.hypot(point[0] - start[0], point[1] - start[1]);
    }
    const t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy);
    const clamped = Math.max(0, Math.min(1, t));
    return Math.hypot(
      point[0] - (start[0] + clamped * dx),
      point[1] - (start[1] + clamped * dy),
    );
  }

  function simplify(points, tolerance) {
    if (points.length <= 3) return points;
    let maxDistance = 0;
    let index = 0;
    const start = points[0];
    const end = points[points.length - 1];
    for (let i = 1; i < points.length - 1; i++) {
      const distance = perpDist(points[i], start, end);
      if (distance > maxDistance) {
        maxDistance = distance;
        index = i;
      }
    }
    if (maxDistance > tolerance) {
      const left = simplify(points.slice(0, index + 1), tolerance);
      const right = simplify(points.slice(index), tolerance);
      return left.slice(0, -1).concat(right);
    }
    return [start, end];
  }

  function ringCentroid(ring) {
    let sx = 0;
    let sy = 0;
    for (const point of ring) {
      sx += point[0];
      sy += point[1];
    }
    return [sx / ring.length, sy / ring.length];
  }

  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  function signedDistToRing(x, y, ring) {
    let minDist = Infinity;
    for (let i = 0; i < ring.length - 1; i++) {
      const d = perpDist([x, y], ring[i], ring[i + 1]);
      if (d < minDist) minDist = d;
    }
    return pointInRing(x, y, ring) ? minDist : -minDist;
  }

  // pole of inaccessibility — 最大内接圆圆心，稳定落在形状内部
  function polylabel(ring, precision) {
    precision = precision || 1.5;
    let minX = ring[0][0];
    let minY = ring[0][1];
    let maxX = minX;
    let maxY = minY;
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const w = maxX - minX;
    const h = maxY - minY;
    if (w === 0 || h === 0) return [minX, minY];

    let bestX = (minX + maxX) / 2;
    let bestY = (minY + maxY) / 2;
    let bestDist = signedDistToRing(bestX, bestY, ring);

    let step = Math.min(w, h) / 8;
    while (step > precision) {
      const x0 = Math.max(minX, bestX - step * 5);
      const x1 = Math.min(maxX, bestX + step * 5);
      const y0 = Math.max(minY, bestY - step * 5);
      const y1 = Math.min(maxY, bestY + step * 5);
      for (let x = x0; x <= x1; x += step) {
        for (let y = y0; y <= y1; y += step) {
          const d = signedDistToRing(x, y, ring);
          if (d > bestDist) {
            bestDist = d;
            bestX = x;
            bestY = y;
          }
        }
      }
      step /= 2;
    }
    return [bestX, bestY];
  }

  function closeRing(points) {
    if (!points.length) return points;
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) return points;
    return points.concat([[first[0], first[1]]]);
  }

  function isRenderableFeature(feature) {
    const props = feature?.properties || {};
    const adcode = String(props.adcode || '');
    const name = props.name || '';
    return Boolean(name) && !adcode.includes('_JD');
  }

  function forEachCoordinate(geometry, callback) {
    const visit = (coords) => {
      if (!Array.isArray(coords) || !coords.length) return;
      if (typeof coords[0] === 'number') {
        callback(coords);
        return;
      }
      coords.forEach(visit);
    };
    visit(geometry.coordinates);
  }

  function pathForCode(code) {
    return `data/boundaries/${code}_full.js`;
  }

  function regionReferenceLngLat(region) {
    if (Array.isArray(region.center) && region.center.length === 2) return region.center;
    if (Array.isArray(region.centroid) && region.centroid.length === 2) return region.centroid;
    return null;
  }

  function loadBoundaryData(code) {
    const key = String(code);
    if (boundaryCache[key]) {
      return Promise.resolve(boundaryCache[key]);
    }
    if (boundaryPromises.has(key)) {
      return boundaryPromises.get(key);
    }

    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = pathForCode(key);
      script.async = true;
      script.dataset.boundaryCode = key;
      script.onload = () => {
        if (boundaryCache[key]) {
          resolve(boundaryCache[key]);
          return;
        }
        reject(new Error(`本地边界文件加载成功，但未注册数据：${key}`));
      };
      script.onerror = () => reject(new Error(`无法加载本地边界文件：${key}`));
      document.head.appendChild(script);
    }).finally(() => {
      boundaryPromises.delete(key);
    });

    boundaryPromises.set(key, promise);
    return promise;
  }

  function poiShardPath(adcode) {
    return `data/pois/${adcode}.js`;
  }

  function hasPoiShard(adcode) {
    if (!poiManifest) return false;
    const shards = poiManifest.shards || poiManifest.byAdcode || {};
    return Boolean(shards[String(adcode)]);
  }

  function loadPoiShard(adcode) {
    const key = String(adcode);
    if (poiShardCache[key]) {
      return Promise.resolve(poiShardCache[key]);
    }
    if (poiShardPromises.has(key)) {
      return poiShardPromises.get(key);
    }
    if (!hasPoiShard(key)) {
      poiShardCache[key] = [];
      return Promise.resolve(poiShardCache[key]);
    }

    const promise = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = poiShardPath(key);
      script.async = true;
      script.dataset.poiAdcode = key;
      script.onload = () => {
        if (!Array.isArray(poiShardCache[key])) {
          poiShardCache[key] = [];
        }
        resolve(poiShardCache[key]);
      };
      script.onerror = () => {
        console.warn(`无法加载 POI 分片：${key}`);
        poiShardCache[key] = [];
        resolve(poiShardCache[key]);
      };
      document.head.appendChild(script);
    }).finally(() => {
      poiShardPromises.delete(key);
    });

    poiShardPromises.set(key, promise);
    return promise;
  }

  function fitProjection(geoJson) {
    const targetMinX = 90;
    const targetMinY = 40;
    const targetMaxX = 910;
    const targetMaxY = 760;
    const baseProjection = d3.geoMercator().scale(1).translate([0, 0]);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const feature of geoJson.features.filter(isRenderableFeature)) {
      forEachCoordinate(feature.geometry, (coord) => {
        const point = baseProjection(coord);
        if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return;
        minX = Math.min(minX, point[0]);
        maxX = Math.max(maxX, point[0]);
        minY = Math.min(minY, point[1]);
        maxY = Math.max(maxY, point[1]);
      });
    }

    const width = Math.max(1e-6, maxX - minX);
    const height = Math.max(1e-6, maxY - minY);
    const scale = Math.min((targetMaxX - targetMinX) / width, (targetMaxY - targetMinY) / height);
    const translateX = (targetMinX + targetMaxX) / 2 - scale * (minX + maxX) / 2;
    const translateY = (targetMinY + targetMaxY) / 2 - scale * (minY + maxY) / 2;

    projection = d3.geoMercator()
      .scale(scale)
      .translate([translateX, translateY]);
  }

  function buildRegions(geoJson) {
    const tolerance = currentDepth() === 0 ? 1.1 : currentDepth() === 1 ? 0.55 : 0.25;
    const regions = [];

    for (const feature of geoJson.features.filter(isRenderableFeature)) {
      const rings = [];
      const geometry = feature.geometry;
      const props = feature.properties || {};
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;

      const collectPolygon = (polygon) => {
        for (const ring of polygon) {
          const projected = ring
            .map((point) => projection(point))
            .filter((point) => point && Number.isFinite(point[0]) && Number.isFinite(point[1]));
          if (projected.length < 4) continue;
          projected.forEach((point) => {
            minX = Math.min(minX, point[0]);
            maxX = Math.max(maxX, point[0]);
            minY = Math.min(minY, point[1]);
            maxY = Math.max(maxY, point[1]);
          });
          const simplified = simplify(projected, tolerance);
          const closed = closeRing(simplified);
          if (closed.length >= 4) rings.push(closed);
        }
      };

      if (geometry.type === 'Polygon') {
        collectPolygon(geometry.coordinates);
      } else if (geometry.type === 'MultiPolygon') {
        geometry.coordinates.forEach(collectPolygon);
      }

      if (!rings.length) continue;

      rings.sort((left, right) => right.length - left.length);
      const centroid = polylabel(rings[0]);
      const adcodeStr = String(props.adcode);
      regions.push({
        adcode: adcodeStr,
        statGroup: statGroupFor(adcodeStr),
        name: props.name || '',
        level: props.level || '',
        parentCode: props.parentCode || '',
        childrenNum: Number(props.childrenNum || 0),
        center: props.center || null,
        centroid: props.centroid || null,
        acroutes: props.acroutes || [],
        feature,
        rings,
        cx: centroid[0],
        cy: centroid[1],
        bboxWidth: maxX - minX,
        bboxHeight: maxY - minY,
        areaEstimate: (maxX - minX) * (maxY - minY),
      });
    }

    return regions;
  }

  function getRegionColor(region) {
    const theme = currentTheme();
    const palette = theme.surfaces;
    return palette[hashCode(region.adcode) % palette.length] || theme.neutral;
  }

  function recomputeRadiusSelection() {
    const tool = state.radiusTool;
    tool.matchedCodes = [];
    tool.anchorScreen = null;
    if (!tool.anchorLngLat) return;

    const screenPoint = projection(tool.anchorLngLat);
    if (screenPoint && Number.isFinite(screenPoint[0]) && Number.isFinite(screenPoint[1])) {
      tool.anchorScreen = screenPoint;
    }

    tool.matchedCodes = state.regions
      .filter((region) => {
        const target = regionReferenceLngLat(region);
        if (!target) return false;
        return haversineKm(tool.anchorLngLat, target) <= tool.radiusKm;
      })
      .map((region) => region.adcode);
  }

  function isRegionWithinRadius(region) {
    return state.radiusTool.matchedCodes.includes(region.adcode);
  }

  function renderRadiusTool() {
    if (!radiusToolEl) return;
    const tool = state.radiusTool;
    const unitLabel = getCurrentUnitLabel();
    const placingText = '请在地图上单击落点，系统会按当前半径圈出命中区域。';
    const anchorText = tool.anchorLngLat
      ? `已设置锚点，当前半径命中 ${tool.matchedCodes.length} 个${unitLabel}。`
      : '未设置锚点。点击“标记点位”后，在地图上落一个中心点。';
    const statusText = tool.placing ? placingText : anchorText;

    radiusToolEl.classList.remove('hidden');
    radiusToolEl.innerHTML = `
      <div class="tool-title">半 径 圈 选</div>
      <div class="tool-status">${statusText}</div>
      <div class="tool-actions">
        <button class="tool-btn${tool.placing ? ' active' : ''}" id="radius-place-btn">${tool.placing ? '等 待 落 点' : '标 记 点 位'}</button>
        <button class="tool-btn secondary" id="radius-clear-btn"${tool.anchorLngLat ? '' : ' disabled'}>清 除 圈 选</button>
      </div>
      <div class="tool-slider">
        <label>半径范围 <span class="tool-value">${tool.radiusKm} km</span></label>
        <input type="range" id="radius-range" min="50" max="1200" step="10" value="${tool.radiusKm}">
      </div>
      <div class="tool-meta">按“区域中心点是否落入半径”判断命中。签子会优先落在圈内区域，圈内无人时退回到当前可见区域。该工具是区域级筛选，不精确到 POI 级。</div>
    `;

    radiusToolEl.querySelector('#radius-place-btn').onclick = () => {
      tool.placing = !tool.placing;
      renderRadiusTool();
    };

    radiusToolEl.querySelector('#radius-clear-btn').onclick = () => {
      tool.placing = false;
      tool.anchorLngLat = null;
      recomputeRadiusSelection();
      renderRadiusTool();
      renderMap();
    };

    radiusToolEl.querySelector('#radius-range').oninput = (event) => {
      tool.radiusKm = Number(event.target.value);
      recomputeRadiusSelection();
      renderRadiusTool();
      renderMap();
    };
  }

  function isRegionFilteredIn(region) {
    if (currentDepth() !== 0 || !statScheme) return true;
    if (!region.statGroup) return true;
    return !!state.regionFilter[region.statGroup];
  }

  function getCurrentUnitLabel() {
    if (!state.currentData?.features?.length) return '地区';
    const level = state.currentData.features[0].properties.level || 'province';
    return LEVEL_LABELS[level] || '地区';
  }

  function updatePanels() {
    const current = state.stack[state.stack.length - 1];
    const unitLabel = getCurrentUnitLabel();
    scopeNameEl.textContent = current.name;
    scopeMetaEl.textContent = currentDepth() < MAX_DEPTH
      ? `当前展示 ${unitLabel} · 点击区域继续下钻或查看详情`
      : '当前展示区县单位 · 掷签抽取区县内真实 POI';
    scopeCountEl.textContent = `${state.regions.length} 个${unitLabel}`;

    const poiTotal = poiManifest?.totalPois || 0;
    const poiLine = poiTotal > 0
      ? `POI 数据 © OpenStreetMap · ${poiTotal.toLocaleString('zh-CN')} 条（ODbL）`
      : 'POI 数据 © OpenStreetMap contributors（ODbL，待生成）';
    if (manifest) {
      dataSourceEl.textContent =
        `边界 · ${manifest.source.provider} · 生成于 ${formatTime(manifest.generatedAt)}｜${poiLine}`;
    } else {
      dataSourceEl.textContent = poiLine;
    }

    goUpBtn.disabled = state.stack.length <= 1;
    goHomeBtn.disabled = state.stack.length <= 1;
    renderRegionFilter();
    renderRadiusTool();
    renderDestinationCard();
    updateDartButtons();
  }

  function destinationSourceLabel(sourceType) {
    if (sourceType === 'osm') return 'OSM POI';
    if (sourceType === 'random') return '区县内随机落点';
    return '未知来源';
  }

  function buildDestinationPath(region) {
    return state.stack.slice(1).map((node) => node.name).concat(region.name).join(' / ');
  }

  function setDestinationStatus(text) {
    state.destinationStatus = text || '';
    renderDestinationCard();
  }

  async function copyToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }

  function clearFinalDestination() {
    state.finalDestination = null;
    state.destinationStatus = '';
  }

  function setFinalDestination(region, destination) {
    state.finalDestination = {
      ...destination,
      regionAdcode: region.adcode,
      regionName: region.name,
      level: region.level,
      pathLabel: buildDestinationPath(region),
      amapUrl: createAmapUrl(destination.lng, destination.lat, destination.name),
    };
    state.destinationStatus = '';
    renderDestinationCard();
    renderMap();
  }

  function renderDestinationCard() {
    if (!destinationCard) return;
    const destination = state.finalDestination;
    if (!destination) {
      destinationCard.classList.add('hidden');
      destinationCard.innerHTML = '';
      return;
    }

    destinationCard.classList.remove('hidden');
    destinationCard.innerHTML = `
      <div class="destination-title">目 的 地</div>
      <h3>${destination.name}</h3>
      <div class="destination-tags">
        <span class="destination-tag">${destinationSourceLabel(destination.sourceType)}</span>
      </div>
      <div class="destination-meta">所属路径：${destination.pathLabel}</div>
      <div class="destination-meta">经纬度：${formatCoords(destination.lng, destination.lat)}</div>
      ${destination.kind && destination.kind !== 'unknown' && destination.kind !== 'other'
        ? `<div class="destination-meta">类型：${destination.kind}</div>`
        : ''}
      <div class="destination-actions">
        <button class="destination-btn" id="copy-destination-coords">复制经纬度</button>
        <button class="destination-btn secondary" id="open-destination-amap">高德打开</button>
      </div>
      <div class="destination-status">${state.destinationStatus || '等权从该区县的 OSM POI 中随机抽取；无 POI 覆盖时回退到区县内几何随机点。'}</div>
    `;

    destinationCard.querySelector('#copy-destination-coords').onclick = async () => {
      try {
        await copyToClipboard(formatCoords(destination.lng, destination.lat));
        setDestinationStatus('经纬度已复制，可直接发给同行或贴到地图应用。');
      } catch (error) {
        console.error(error);
        setDestinationStatus('复制失败，请手动选取结果卡中的经纬度。');
      }
    };

    destinationCard.querySelector('#open-destination-amap').onclick = () => {
      window.open(destination.amapUrl, '_blank', 'noopener');
      setDestinationStatus('已尝试打开高德标记页。');
    };
  }

  function renderRegionFilter() {
    const el = document.getElementById('region-filter');
    if (!el || !statScheme) return;
    if (currentDepth() !== 0) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    el.classList.remove('hidden');
    const theme = currentTheme();
    const counts = {};
    for (const r of state.regions) {
      const k = r.statGroup || 'other';
      counts[k] = (counts[k] || 0) + 1;
    }
    const swatches = {
      eastern: theme.surfaces[5] || theme.surfaces[0],
      central: theme.surfaces[2] || theme.surfaces[0],
      western: theme.surfaces[1] || theme.surfaces[0],
      northeastern: theme.surfaces[3] || theme.surfaces[0],
      excluded: theme.neutral,
    };
    const rows = STAT_ORDER.map((key) => {
      const meta = STAT_META[key];
      if (!meta) return '';
      const count = counts[key] || 0;
      const off = !state.regionFilter[key];
      return `
        <div class="filter-row${off ? ' off' : ''}" data-key="${key}">
          <span class="filter-swatch" style="background:${swatches[key] || theme.neutral}"></span>
          <span class="filter-label">${meta.name}</span>
          <span class="filter-count">${count}</span>
        </div>
      `;
    }).join('');
    el.innerHTML = `<div class="filter-title">地 区 筛 选</div>${rows}`;
    el.querySelectorAll('.filter-row').forEach((row) => {
      row.onclick = () => {
        const key = row.dataset.key;
        state.regionFilter[key] = !state.regionFilter[key];
        row.classList.toggle('off', !state.regionFilter[key]);
        renderMap();
        updateDartButtons();
      };
    });
  }

  function renderBreadcrumb() {
    breadcrumbEl.innerHTML = '';
    state.stack.forEach((node, index) => {
      const button = document.createElement('button');
      button.className = 'crumb' + (index === state.stack.length - 1 ? ' active' : '');
      button.textContent = node.name;
      if (index !== state.stack.length - 1) {
        button.onclick = () => {
          openBoundary(node.code, state.stack.slice(0, index + 1));
        };
      } else {
        button.disabled = true;
      }
      breadcrumbEl.appendChild(button);
      if (index !== state.stack.length - 1) {
        const sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = '›';
        breadcrumbEl.appendChild(sep);
      }
    });
  }

  function renderLegend() {
    const unitLabel = getCurrentUnitLabel();
    legendEl.innerHTML = `
      <b>图例 · 掷签问地</b>
      <div>■ 当前层级：${unitLabel}</div>
      <div>■ 点击有子级的区域进入下一层</div>
      <div>■ 到区县级后，掷签等权抽取 OSM POI</div>
      <div>■ 无 POI 覆盖时回退到区县内几何随机点</div>
    `;
  }

  function infoHtml(region) {
    const levelLabel = CARD_LEVEL_LABELS[region.level] || '地区';
    const actionText = region.childrenNum > 0 && currentDepth() < MAX_DEPTH
      ? `点击可继续进入下一级 · 下辖 ${region.childrenNum} 个单位`
      : '当前为叶子区县 · 掷签抽取区县内 OSM POI';
    return `
      <h4>${region.name}</h4>
      <span class="tier-tag">${levelLabel}</span>
      <div class="note">行政代码：${region.adcode}</div>
      <div class="note">${actionText}</div>
    `;
  }

  function showInfoCard(region, x, y) {
    infoCard.innerHTML = infoHtml(region);
    infoCard.style.display = 'block';
    infoCard.style.left = Math.min(x + 14, window.innerWidth - 260) + 'px';
    infoCard.style.top = Math.min(y + 14, window.innerHeight - 150) + 'px';
  }

  function hideInfoCard() {
    infoCard.style.display = 'none';
  }

  function appendDestinationOverlay() {
    if (!state.finalDestination) return;
    const marker = projectLngLatToScreen(projection, [state.finalDestination.lng, state.finalDestination.lat]);
    if (!Number.isFinite(marker.x) || !Number.isFinite(marker.y)) return;

    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    overlay.setAttribute('class', 'destination-overlay');
    overlay.setAttribute('transform', `translate(${marker.x.toFixed(1)},${marker.y.toFixed(1)})`);

    const halo = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    halo.setAttribute('class', 'destination-halo');
    halo.setAttribute('r', '16');
    overlay.appendChild(halo);

    const pin = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    pin.setAttribute('class', 'destination-pin');
    pin.setAttribute('r', '6.5');
    overlay.appendChild(pin);

    const labelBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    const labelWidth = Math.min(220, Math.max(92, state.finalDestination.name.length * 15));
    labelBg.setAttribute('class', 'destination-label-bg');
    labelBg.setAttribute('x', String(-labelWidth / 2));
    labelBg.setAttribute('y', '-44');
    labelBg.setAttribute('rx', '10');
    labelBg.setAttribute('ry', '10');
    labelBg.setAttribute('width', String(labelWidth));
    labelBg.setAttribute('height', '24');
    overlay.appendChild(labelBg);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('class', 'destination-label');
    label.setAttribute('x', '0');
    label.setAttribute('y', '-28');
    label.textContent = state.finalDestination.name;
    overlay.appendChild(label);

    MAP.appendChild(overlay);
  }

  function renderMap() {
    if (!state.regions.length) return;
    MAP.innerHTML = '';
    const matchedSet = new Set(state.radiusTool.matchedCodes);
    const hasRadiusSelection = Boolean(state.radiusTool.anchorLngLat);

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `
      <pattern id="texture-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(60,40,20,0.18)" stroke-width="0.5"/>
      </pattern>
    `;
    MAP.appendChild(defs);

    const regionGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    regionGroup.setAttribute('id', 'regions');

    const bindRegionInteractions = (target, region) => {
      target.addEventListener('mouseenter', (event) => {
        showInfoCard(region, event.clientX, event.clientY);
      });
      target.addEventListener('mouseleave', hideInfoCard);
      target.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (state.radiusTool.placing) {
          setRadiusAnchorFromClient(event.clientX, event.clientY);
          return;
        }
        if (region.childrenNum > 0 && currentDepth() < MAX_DEPTH) {
          await openBoundary(region.adcode, state.stack.concat([{ code: region.adcode, name: region.name }]));
          return;
        }
        showInfoCard(region, event.clientX, event.clientY);
      });
    };

    state.regions.forEach((region) => {
      if (!isRegionFilteredIn(region)) return;
      const color = getRegionColor(region);
      const withinRadius = matchedSet.has(region.adcode);
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.setAttribute('class', 'province');
      group.setAttribute('data-code', region.adcode);

      const pathD = multiPointsToPath(region.rings);
      const topPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      topPath.setAttribute('d', pathD);
      topPath.setAttribute('fill-rule', 'evenodd');
      topPath.setAttribute(
        'class',
        `province-top${hasRadiusSelection ? (withinRadius ? ' in-radius' : ' out-of-radius') : ''}`,
      );
      topPath.setAttribute('fill', color);
      topPath.setAttribute('data-name', region.name);
      topPath.setAttribute('data-code', region.adcode);
      bindRegionInteractions(topPath, region);
      group.appendChild(topPath);

      const hatch = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hatch.setAttribute('d', pathD);
      hatch.setAttribute('fill-rule', 'evenodd');
      hatch.setAttribute('fill', 'url(#texture-hatch)');
      hatch.setAttribute('pointer-events', 'none');
      hatch.setAttribute('opacity', '0.52');
      group.appendChild(hatch);

      regionGroup.appendChild(group);
    });

    MAP.appendChild(regionGroup);
    appendDestinationOverlay();

    if (state.radiusTool.anchorScreen) {
      const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      overlay.setAttribute('class', 'radius-overlay');
      const [ax, ay] = state.radiusTool.anchorScreen;
      const radiusPx = projectedRadiusPx(state.radiusTool.anchorLngLat, state.radiusTool.radiusKm);

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('class', 'radius-ring');
      circle.setAttribute('cx', ax.toFixed(1));
      circle.setAttribute('cy', ay.toFixed(1));
      circle.setAttribute('r', radiusPx.toFixed(1));
      overlay.appendChild(circle);

      const anchor = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      anchor.setAttribute('class', 'radius-anchor');
      anchor.setAttribute('cx', ax.toFixed(1));
      anchor.setAttribute('cy', ay.toFixed(1));
      anchor.setAttribute('r', '5');
      overlay.appendChild(anchor);

      const crossH = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      crossH.setAttribute('class', 'radius-cross');
      crossH.setAttribute('x1', (ax - 9).toFixed(1));
      crossH.setAttribute('x2', (ax + 9).toFixed(1));
      crossH.setAttribute('y1', ay.toFixed(1));
      crossH.setAttribute('y2', ay.toFixed(1));
      overlay.appendChild(crossH);

      const crossV = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      crossV.setAttribute('class', 'radius-cross');
      crossV.setAttribute('x1', ax.toFixed(1));
      crossV.setAttribute('x2', ax.toFixed(1));
      crossV.setAttribute('y1', (ay - 9).toFixed(1));
      crossV.setAttribute('y2', (ay + 9).toFixed(1));
      overlay.appendChild(crossV);

      MAP.appendChild(overlay);
    }
  }

  async function openBoundary(code, nextStack) {
    const currentNode = nextStack[nextStack.length - 1];
    const loadingName = currentNode ? currentNode.name : '全国';
    showLoading(true, `边 界 装 载 中 · ${loadingName}`);
    hideInfoCard();
    clearDarts();
    clearFinalDestination();

    try {
      const geoJson = await loadBoundaryData(code);
      fitProjection(geoJson);
      state.stack = nextStack;
      state.currentData = geoJson;
      state.regions = buildRegions(geoJson);
      recomputeRadiusSelection();
      updatePanels();
      renderBreadcrumb();
      renderLegend();
      renderMap();
      resetTransform();
      showLoading(false);
    } catch (error) {
      console.error(error);
      showError(`边界数据加载失败：${loadingName}`);
    }
  }

  function dartSVG(color) {
    const bamboo = '#d9b97a';
    const bambooShade = '#a07a3c';
    return `<svg width="60" height="90" viewBox="0 0 60 90">
      <defs><filter id="df" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="2"/></filter></defs>
      <ellipse cx="30" cy="82" rx="10" ry="2.5" fill="rgba(0,0,0,0.32)" filter="url(#df)"/>
      <rect x="26" y="6" width="8" height="64" fill="${bamboo}" stroke="#3a2e1f" stroke-width="0.8" rx="1"/>
      <rect x="26" y="6" width="8" height="20" fill="${color}" stroke="#3a2e1f" stroke-width="0.8" rx="1"/>
      <line x1="26" y1="30" x2="34" y2="30" stroke="${bambooShade}" stroke-width="0.7"/>
      <line x1="26" y1="50" x2="34" y2="50" stroke="${bambooShade}" stroke-width="0.7"/>
      <path d="M26,70 L30,82 L34,70 Z" fill="${bamboo}" stroke="#3a2e1f" stroke-width="0.8" stroke-linejoin="round"/>
      <path d="M30,10 L30,22" stroke="${darken(color, 0.35)}" stroke-width="0.8" stroke-linecap="round"/>
    </svg>`;
  }

  function mapPointToViewport(point) {
    const pt = MAP.createSVGPoint();
    pt.x = point.x;
    pt.y = point.y;
    const matrix = MAP.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const screen = pt.matrixTransform(matrix);
    return { x: screen.x, y: screen.y };
  }

  function lngLatToViewport(lngLat) {
    const mapPoint = projectLngLatToScreen(projection, lngLat);
    return mapPointToViewport(mapPoint);
  }

  function screenToMap(clientX, clientY) {
    const matrix = MAP.getScreenCTM();
    if (!matrix) return null;
    const point = MAP.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    return point.matrixTransform(matrix.inverse());
  }

  function projectedRadiusPx(anchorLngLat, radiusKm) {
    const [lng, lat] = anchorLngLat;
    const point = projection(anchorLngLat);
    if (!point) return 0;
    const cosLat = Math.max(0.15, Math.cos(lat * Math.PI / 180));
    const deltaLng = radiusKm / (111.32 * cosLat);
    const eastPoint = projection([lng + deltaLng, lat]);
    if (!eastPoint) return 0;
    return Math.hypot(eastPoint[0] - point[0], eastPoint[1] - point[1]);
  }

  function setRadiusAnchorFromClient(clientX, clientY) {
    const mapPoint = screenToMap(clientX, clientY);
    if (!mapPoint) return;
    const lngLat = projection.invert([mapPoint.x, mapPoint.y]);
    if (!lngLat || !Number.isFinite(lngLat[0]) || !Number.isFinite(lngLat[1])) return;
    state.radiusTool.anchorLngLat = lngLat;
    state.radiusTool.placing = false;
    recomputeRadiusSelection();
    renderRadiusTool();
    renderMap();
  }

  function clearDarts() {
    state.darts.forEach((d) => d.el.remove());
    state.darts = [];
  }

  function updateDartButtons() {
    stopFireBtn.disabled = !state.continuousFire;
    const busy = state.continuousFire;
    fireDartBtn.disabled = busy;
    continuousFireBtn.disabled = busy || !state.regions.length || currentDepth() >= MAX_DEPTH;
  }

  function pickCurrentRegion() {
    return pickRegionForCurrentDepth({
      regions: state.regions,
      currentDepth: currentDepth(),
      maxDepth: MAX_DEPTH,
      hasRadiusSelection: Boolean(state.radiusTool.anchorLngLat),
      isRegionFilteredIn,
      isRegionWithinRadius,
    }, Math.random);
  }

  async function planDartTarget() {
    if (!state.regions.length) return null;
    const region = pickCurrentRegion();
    if (!region) return null;

    const isLeaf = Number(region.childrenNum || 0) === 0 || currentDepth() >= MAX_DEPTH;
    if (!isLeaf) {
      return {
        region,
        destination: null,
        targetLngLat: pickRandomImpactLngLat(region, geoOps, Math.random, 300),
      };
    }

    const shard = await loadPoiShard(region.adcode);
    const destination = resolveDestination(region, { [region.adcode]: shard }, geoOps, Math.random);
    return {
      region,
      destination,
      targetLngLat: [destination.lng, destination.lat],
    };
  }

  async function fireDart() {
    if (state.finalDestination) {
      clearFinalDestination();
      renderDestinationCard();
      renderMap();
    }

    const planned = await planDartTarget();
    if (!planned) return null;

    const targetViewport = lngLatToViewport(planned.targetLngLat);
    const color = getRegionColor(planned.region);
    const side = Math.floor(Math.random() * 4);
    const W = window.innerWidth;
    const H = window.innerHeight;
    let sx;
    let sy;
    if (side === 0) { sx = -80; sy = Math.random() * H; }
    else if (side === 1) { sx = W + 80; sy = Math.random() * H; }
    else if (side === 2) { sx = Math.random() * W; sy = -80; }
    else { sx = Math.random() * W; sy = H + 80; }

    const el = document.createElement('div');
    el.className = 'dart';
    el.innerHTML = dartSVG(color);
    el.style.left = (sx - 30) + 'px';
    el.style.top = (sy - 82) + 'px';
    el.style.opacity = '0';
    dartLayer.appendChild(el);

    const duration = 900;
    const startAngle = Math.random() * 720 - 360;
    const dx = targetViewport.x - sx;
    const dy = targetViewport.y - sy;
    const arc = -Math.min(200, Math.abs(dx) * 0.3 + 50);
    const midX = sx + dx * 0.5;
    const midY = sy + dy * 0.5 + arc;

    const frames = [];
    const N = 24;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const x = (1 - t) * (1 - t) * sx + 2 * (1 - t) * t * midX + t * t * targetViewport.x;
      const y = (1 - t) * (1 - t) * sy + 2 * (1 - t) * t * midY + t * t * targetViewport.y;
      const tx2 = 2 * (1 - t) * (midX - sx) + 2 * t * (targetViewport.x - midX);
      const ty2 = 2 * (1 - t) * (midY - sy) + 2 * t * (targetViewport.y - midY);
      const heading = Math.atan2(ty2, tx2) * 180 / Math.PI + 90;
      const angle = t < 0.8
        ? (startAngle * (1 - t / 0.8) + heading * (t / 0.8))
        : heading;
      frames.push({
        transform: `translate(${x - sx}px, ${y - sy}px) rotate(${angle}deg) scale(${0.5 + t * 0.5})`,
        opacity: t < 0.05 ? t * 20 : 1,
      });
    }

    const anim = el.animate(frames, { duration, easing: 'ease-in', fill: 'forwards' });

    return new Promise((resolve) => {
      anim.onfinish = () => {
        el.style.left = (targetViewport.x - 30) + 'px';
        el.style.top = (targetViewport.y - 82) + 'px';
        el.style.transform = 'rotate(0deg) scale(1)';
        el.style.opacity = '1';
        anim.cancel();
        el.animate([
          { transform: 'rotate(-8deg) scale(1.05)' },
          { transform: 'rotate(5deg) scale(1)' },
          { transform: 'rotate(-2deg) scale(1)' },
          { transform: 'rotate(0deg) scale(1)' },
        ], { duration: 400 });
        el.style.pointerEvents = 'auto';
        el.style.cursor = 'pointer';
        el.title = '拾起这支签';
        const entry = { el, region: planned.region, destination: planned.destination };
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          el.remove();
          const i = state.darts.indexOf(entry);
          if (i !== -1) state.darts.splice(i, 1);
        });
        state.darts.push(entry);
        resolve({ ...planned, targetViewport });
      };
    });
  }

  async function fireAndDrill() {
    const result = await fireDart();
    if (!result) return null;

    if (result.destination) {
      hideInfoCard();
      setFinalDestination(result.region, result.destination);
      return { drilled: false, destination: result.destination, region: result.region };
    }

    showInfoCard(result.region, result.targetViewport.x, result.targetViewport.y);
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (result.region.childrenNum > 0 && currentDepth() < MAX_DEPTH) {
      await openBoundary(
        result.region.adcode,
        state.stack.concat([{ code: result.region.adcode, name: result.region.name }]),
      );
      return { drilled: true, region: result.region };
    }
    return null;
  }

  async function startContinuous() {
    if (state.continuousFire) return;
    state.continuousFire = true;
    updateDartButtons();
    try {
      while (state.continuousFire) {
        const outcome = await fireAndDrill();
        if (!outcome || !state.continuousFire) break;
        if (!outcome.drilled) break;
        await new Promise((resolve) => setTimeout(resolve, 450));
      }
    } finally {
      state.continuousFire = false;
      updateDartButtons();
    }
  }

  function stopContinuous() {
    state.continuousFire = false;
    updateDartButtons();
  }

  function setupDarts() {
    fireDartBtn.onclick = async () => {
      fireDartBtn.disabled = true;
      await fireAndDrill();
      updateDartButtons();
    };
    continuousFireBtn.onclick = startContinuous;
    stopFireBtn.onclick = stopContinuous;
    clearDartsBtn.onclick = clearDarts;
    updateDartButtons();
  }

  function setupNavigation() {
    goUpBtn.onclick = () => {
      if (state.stack.length <= 1) return;
      const nextStack = state.stack.slice(0, -1);
      const parent = nextStack[nextStack.length - 1];
      openBoundary(parent.code, nextStack);
    };

    goHomeBtn.onclick = () => {
      openBoundary(ROOT_CODE, [{ code: ROOT_CODE, name: '全国' }]);
    };
  }

  function setupZoom() {
    stage.addEventListener('wheel', (event) => {
      event.preventDefault();
      const delta = -event.deltaY * 0.0018;
      const oldTarget = state.targetScale;
      state.targetScale = Math.max(0.5, Math.min(4, oldTarget * (1 + delta)));
      const rect = stage.getBoundingClientRect();
      const mx = event.clientX - rect.left - rect.width / 2;
      const my = event.clientY - rect.top - rect.height / 2;
      const factor = state.targetScale / oldTarget;
      state.targetTx = mx - (mx - state.targetTx) * factor;
      state.targetTy = my - (my - state.targetTy) * factor;
      scheduleRender();
    }, { passive: false });

    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    stage.addEventListener('mousedown', (event) => {
      if (event.target.closest('.controls, .legend, .tweaks, .zoom-ctrl, .info-card, .breadcrumb, .tweaks-toggle')) return;
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      stage.classList.add('dragging');
      snapTransform();
    });

    window.addEventListener('mousemove', (event) => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      state.tx += dx;
      state.ty += dy;
      state.targetTx = state.tx;
      state.targetTy = state.ty;
      lastX = event.clientX;
      lastY = event.clientY;
      applyTransform();
    });

    window.addEventListener('mouseup', () => {
      dragging = false;
      stage.classList.remove('dragging');
    });

    document.getElementById('zoom-in').onclick = () => {
      state.targetScale = Math.min(4, state.targetScale * 1.2);
      scheduleRender();
    };
    document.getElementById('zoom-out').onclick = () => {
      state.targetScale = Math.max(0.5, state.targetScale / 1.2);
      scheduleRender();
    };
    document.getElementById('zoom-reset').onclick = resetTransform;
  }

  function setupTweaks() {
    const panel = document.getElementById('tweaks-panel');
    panel.querySelectorAll('[data-theme]').forEach((button) => {
      if (button.dataset.theme === TWEAKS.colorTheme) {
        button.classList.add('active');
      }
      button.onclick = () => {
        TWEAKS.colorTheme = button.dataset.theme;
        panel.querySelectorAll('[data-theme]').forEach((item) => item.classList.remove('active'));
        button.classList.add('active');
        renderMap();
        renderLegend();
        persist();
      };
    });
  }

  function setupTweaksToggle() {
    if (!tweaksToggle) return;
    tweaksToggle.onclick = () => {
      const panel = document.getElementById('tweaks-panel');
      const open = panel.classList.toggle('visible');
      tweaksToggle.classList.toggle('active', open);
    };
  }

  function setupMessageBridge() {
    window.addEventListener('message', (event) => {
      if (!event.data) return;
      if (event.data.type === '__activate_edit_mode') {
        document.getElementById('tweaks-panel').classList.add('visible');
      }
      if (event.data.type === '__deactivate_edit_mode') {
        document.getElementById('tweaks-panel').classList.remove('visible');
      }
    });
  }

  function setupGlobalClicks() {
    stage.addEventListener('click', (event) => {
      if (state.radiusTool.placing && !event.target.closest('.controls, .legend, .tweaks, .zoom-ctrl, .info-card, .breadcrumb, .tweaks-toggle, .dart-panel, .destination-card')) {
        setRadiusAnchorFromClient(event.clientX, event.clientY);
        hideInfoCard();
        return;
      }
      if (!event.target.closest('.province-top, .info-card, .destination-card')) {
        hideInfoCard();
      }
    });
  }

  async function init() {
    setupNavigation();
    setupZoom();
    setupTweaks();
    setupTweaksToggle();
    setupMessageBridge();
    setupGlobalClicks();
    setupDarts();
    updatePanels();
    renderBreadcrumb();
    renderLegend();
    renderDestinationCard();
    applyTransform();

    try {
      await openBoundary(ROOT_CODE, [{ code: ROOT_CODE, name: '全国' }]);
      try {
        window.parent.postMessage({ type: '__edit_mode_available' }, '*');
      } catch (error) {
        console.warn(error);
      }
    } catch (error) {
      console.error(error);
      showError('初始化失败，请检查本地边界数据');
    }
  }

  init();
})();
