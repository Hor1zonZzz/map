// 华夏舆图 · 行政区划下钻版
(function () {
  'use strict';

  const TWEAKS = /*EDITMODE-BEGIN*/{
    "tiltAngle": 16,
    "heightExaggerate": 1.0,
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
    const k = 0.22;
    state.scale += ds * k;
    state.tx += dx * k;
    state.ty += dy * k;
    applyTransform();
    rafHandle = requestAnimationFrame(renderLoop);
  }
  function scheduleRender() {
    if (rafHandle == null) rafHandle = requestAnimationFrame(renderLoop);
  }

  const boundaryCache = window.__BOUNDARY_DATA__ || (window.__BOUNDARY_DATA__ = Object.create(null));
  const boundaryPromises = new Map();
  const manifest = window.__BOUNDARY_MANIFEST__ || null;

  const MAP = document.getElementById('map-svg');
  const stage = document.getElementById('map-stage');
  const wrap = document.getElementById('map-wrap');
  const loadingEl = document.getElementById('map-loading');
  const infoCard = document.getElementById('info-card');
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

  function project2_5D(points, tilt, heightPx) {
    const k = 1 - tilt * 0.15;
    const base = points.map(([x, y]) => [x, y * k]);
    const top = points.map(([x, y]) => [x, y * k - heightPx]);
    return { base, top };
  }

  function isOuterRing(ring) {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      sum += (x2 - x1) * (y2 + y1);
    }
    return sum < 0;
  }

  function pathForCode(code) {
    return `data/boundaries/${code}_full.js`;
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
      regions.push({
        adcode: String(props.adcode),
        name: props.name || '',
        level: props.level || '',
        parentCode: props.parentCode || '',
        childrenNum: Number(props.childrenNum || 0),
        center: props.center || null,
        centroid: props.centroid || null,
        acroutes: props.acroutes || [],
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

  function getRegionHeight(region) {
    const base = [42, 28, 16][Math.min(currentDepth(), 2)] || 16;
    const extra = currentDepth() < 2 ? Math.min(region.childrenNum || 0, 12) * (currentDepth() === 0 ? 1.1 : 0.55) : 0;
    return (base + extra) * TWEAKS.heightExaggerate;
  }

  function shouldRenderLabel(region) {
    if (currentDepth() === 0) {
      return region.areaEstimate > 1800;
    }
    if (currentDepth() === 1) {
      return state.regions.length <= 24 || region.areaEstimate > 380;
    }
    return state.regions.length <= 12 || region.areaEstimate > 180;
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
    scopeMetaEl.textContent = `当前展示 ${unitLabel} · 点击区域继续下钻或查看详情`;
    scopeCountEl.textContent = `${state.regions.length} 个${unitLabel}`;

    if (manifest) {
      dataSourceEl.textContent =
        `本地静态镜像 · ${manifest.source.provider} · 生成于 ${formatTime(manifest.generatedAt)}`;
    } else {
      dataSourceEl.textContent = '本地静态镜像';
    }

    goUpBtn.disabled = state.stack.length <= 1;
    goHomeBtn.disabled = state.stack.length <= 1;
    updateDartButtons();
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
      <b>图例 · 行政下钻</b>
      <div>■ 当前层级：${unitLabel}</div>
      <div>■ 点击有子级的区域进入下一层</div>
      <div>■ 到区县级后只显示详情，不再继续拆分</div>
    `;
  }

  function infoHtml(region) {
    const levelLabel = CARD_LEVEL_LABELS[region.level] || '地区';
    const actionText = region.childrenNum > 0 && currentDepth() < MAX_DEPTH
      ? `点击可继续进入下一级 · 下辖 ${region.childrenNum} 个单位`
      : '当前已到 V1 叶子层';
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

  function renderMap() {
    if (!state.regions.length) return;
    const tilt = TWEAKS.tiltAngle / 45;
    MAP.innerHTML = '';

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `
      <pattern id="texture-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(60,40,20,0.18)" stroke-width="0.5"/>
      </pattern>
    `;
    MAP.appendChild(defs);

    const sorted = [...state.regions].sort((left, right) => left.cy - right.cy);

    const shadowGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    shadowGroup.setAttribute('class', 'shadow-layer');
    for (const region of sorted) {
      for (const ring of region.rings) {
        const shadowPts = project2_5D(ring, tilt, 0).base.map((point) => [point[0] + 4, point[1] + 4]);
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', pointsToPath(shadowPts));
        path.setAttribute('class', 'province-shadow');
        shadowGroup.appendChild(path);
      }
    }
    MAP.appendChild(shadowGroup);

    const regionGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    regionGroup.setAttribute('id', 'regions');

    sorted.forEach((region) => {
      const color = getRegionColor(region);
      const height = getRegionHeight(region);
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.setAttribute('class', 'province');
      group.setAttribute('data-code', region.adcode);

      for (const ring of region.rings) {
        const projected = project2_5D(ring, tilt, height);
        const outer = isOuterRing(projected.base);
        const sideColor = darken(color, 0.35);
        for (let i = 0; i < projected.base.length - 1; i++) {
          const base1 = projected.base[i];
          const base2 = projected.base[i + 1];
          const top1 = projected.top[i];
          const top2 = projected.top[i + 1];
          const dx = base2[0] - base1[0];
          const faceDown = outer ? dx < 0 : dx > 0;
          if (!faceDown) continue;
          const face = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          face.setAttribute(
            'd',
            `M${base1[0].toFixed(1)},${base1[1].toFixed(1)} L${base2[0].toFixed(1)},${base2[1].toFixed(1)} L${top2[0].toFixed(1)},${top2[1].toFixed(1)} L${top1[0].toFixed(1)},${top1[1].toFixed(1)} Z`,
          );
          face.setAttribute('class', 'province-side');
          face.setAttribute('fill', sideColor);
          group.appendChild(face);
        }
      }

      const topRings = region.rings.map((ring) => project2_5D(ring, tilt, height).top);
      const topPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      topPath.setAttribute('d', multiPointsToPath(topRings));
      topPath.setAttribute('fill-rule', 'evenodd');
      topPath.setAttribute('class', 'province-top');
      topPath.setAttribute('fill', color);
      topPath.setAttribute('data-name', region.name);
      topPath.setAttribute('data-code', region.adcode);
      topPath.addEventListener('mouseenter', (event) => {
        showInfoCard(region, event.clientX, event.clientY);
      });
      topPath.addEventListener('mouseleave', hideInfoCard);
      topPath.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (region.childrenNum > 0 && currentDepth() < MAX_DEPTH) {
          await openBoundary(region.adcode, state.stack.concat([{ code: region.adcode, name: region.name }]));
          return;
        }
        showInfoCard(region, event.clientX, event.clientY);
      });
      group.appendChild(topPath);

      const hatch = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hatch.setAttribute('d', multiPointsToPath(topRings));
      hatch.setAttribute('fill-rule', 'evenodd');
      hatch.setAttribute('fill', 'url(#texture-hatch)');
      hatch.setAttribute('pointer-events', 'none');
      hatch.setAttribute('opacity', '0.52');
      group.appendChild(hatch);

      if (shouldRenderLabel(region)) {
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', region.cx);
        label.setAttribute('y', region.cy * (1 - tilt * 0.15) - height - 2);
        label.setAttribute('class', 'province-label');
        const baseSize = currentDepth() === 0 ? 13 : currentDepth() === 1 ? 11 : 10;
        const charW = baseSize * 0.95;
        const estWidth = region.name.length * charW;
        const maxWidth = region.bboxWidth * 0.85;
        const finalSize = estWidth <= maxWidth
          ? baseSize
          : Math.max(7, Math.floor(maxWidth / (region.name.length * 0.95)));
        label.setAttribute('font-size', String(finalSize));
        label.textContent = region.name;
        group.appendChild(label);
      }

      regionGroup.appendChild(group);
    });

    MAP.appendChild(regionGroup);
  }

  async function openBoundary(code, nextStack) {
    const currentNode = nextStack[nextStack.length - 1];
    const loadingName = currentNode ? currentNode.name : '全国';
    showLoading(true, `边 界 装 载 中 · ${loadingName}`);
    hideInfoCard();
    clearDarts();

    try {
      const geoJson = await loadBoundaryData(code);
      fitProjection(geoJson);
      state.stack = nextStack;
      state.currentData = geoJson;
      state.regions = buildRegions(geoJson);
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
    return `<svg width="70" height="70" viewBox="0 0 70 70">
      <defs><filter id="df" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="2"/></filter></defs>
      <ellipse cx="35" cy="60" rx="12" ry="3" fill="rgba(0,0,0,0.3)" filter="url(#df)"/>
      <line x1="35" y1="5" x2="35" y2="50" stroke="${darken(color, 0.4)}" stroke-width="3" stroke-linecap="round"/>
      <path d="M35,5 L28,15 L35,12 L42,15 Z" fill="${color}" stroke="#3a2e1f" stroke-width="1"/>
      <path d="M35,5 L30,10 L35,8 L40,10 Z" fill="${darken(color, 0.2)}" stroke="#3a2e1f" stroke-width="0.8"/>
      <path d="M35,55 L31,48 L35,50 L39,48 Z" fill="#3a2e1f" stroke="#3a2e1f" stroke-width="1" stroke-linejoin="round"/>
    </svg>`;
  }

  function regionToScreen(region) {
    const tilt = TWEAKS.tiltAngle / 45;
    const h = getRegionHeight(region);
    const pt = MAP.createSVGPoint();
    pt.x = region.cx;
    pt.y = region.cy * (1 - tilt * 0.15) - h;
    const matrix = MAP.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const screen = pt.matrixTransform(matrix);
    return { x: screen.x, y: screen.y };
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

  function fireDart() {
    if (!state.regions.length) return Promise.resolve(null);
    const canDrill = currentDepth() < MAX_DEPTH;
    const pool = canDrill ? state.regions.filter((r) => r.childrenNum > 0) : state.regions;
    const regions = pool.length ? pool : state.regions;
    const region = regions[Math.floor(Math.random() * regions.length)];
    const dest = regionToScreen(region);
    const color = getRegionColor(region);

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
    el.style.left = (sx - 35) + 'px';
    el.style.top = (sy - 35) + 'px';
    el.style.opacity = '0';
    dartLayer.appendChild(el);

    const duration = 900;
    const startAngle = Math.random() * 720 - 360;
    const dx = dest.x - sx;
    const dy = dest.y - sy;
    const arc = -Math.min(200, Math.abs(dx) * 0.3 + 50);
    const midX = sx + dx * 0.5;
    const midY = sy + dy * 0.5 + arc;

    const frames = [];
    const N = 24;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const x = (1 - t) * (1 - t) * sx + 2 * (1 - t) * t * midX + t * t * dest.x;
      const y = (1 - t) * (1 - t) * sy + 2 * (1 - t) * t * midY + t * t * dest.y;
      const tx2 = 2 * (1 - t) * (midX - sx) + 2 * t * (dest.x - midX);
      const ty2 = 2 * (1 - t) * (midY - sy) + 2 * t * (dest.y - midY);
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
        el.style.left = (dest.x - 35) + 'px';
        el.style.top = (dest.y - 35) + 'px';
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
        el.title = '点击删除此飞镖';
        const entry = { el, region };
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          el.remove();
          const i = state.darts.indexOf(entry);
          if (i !== -1) state.darts.splice(i, 1);
        });
        state.darts.push(entry);
        resolve(region);
      };
    });
  }

  async function fireAndDrill() {
    const region = await fireDart();
    if (!region) return null;
    const screen = regionToScreen(region);
    showInfoCard(region, screen.x, screen.y);
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (region.childrenNum > 0 && currentDepth() < MAX_DEPTH) {
      await openBoundary(region.adcode, state.stack.concat([{ code: region.adcode, name: region.name }]));
      return region;
    }
    return null;
  }

  async function startContinuous() {
    if (state.continuousFire) return;
    state.continuousFire = true;
    updateDartButtons();
    try {
      while (state.continuousFire) {
        const drilled = await fireAndDrill();
        if (!drilled || !state.continuousFire) break;
        if (currentDepth() >= MAX_DEPTH) break;
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
    const tiltSlider = panel.querySelector('#tw-tilt');
    const heightSlider = panel.querySelector('#tw-height');

    tiltSlider.value = TWEAKS.tiltAngle;
    panel.querySelector('#tw-tilt-val').textContent = TWEAKS.tiltAngle + '°';
    tiltSlider.oninput = (event) => {
      TWEAKS.tiltAngle = Number(event.target.value);
      panel.querySelector('#tw-tilt-val').textContent = TWEAKS.tiltAngle + '°';
      renderMap();
      persist();
    };

    heightSlider.value = TWEAKS.heightExaggerate;
    panel.querySelector('#tw-height-val').textContent = TWEAKS.heightExaggerate.toFixed(1) + 'x';
    heightSlider.oninput = (event) => {
      TWEAKS.heightExaggerate = Number(event.target.value);
      panel.querySelector('#tw-height-val').textContent = TWEAKS.heightExaggerate.toFixed(1) + 'x';
      renderMap();
      persist();
    };

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
      if (!event.target.closest('.province-top, .info-card')) {
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
