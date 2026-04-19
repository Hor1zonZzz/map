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
    stack: [{ code: ROOT_CODE, name: '全国' }],
    currentData: null,
    regions: [],
  };

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
    document.getElementById('zoom-level').textContent = Math.round(state.scale * 100) + '%';
  }

  function resetTransform() {
    state.scale = 1;
    state.tx = 0;
    state.ty = 0;
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

  function closeRing(points) {
    if (!points.length) return points;
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) return points;
    return points.concat([[first[0], first[1]]]);
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
    projection = d3.geoMercator().fitExtent(
      [[90, 40], [910, 760]],
      geoJson,
    );
  }

  function buildRegions(geoJson) {
    const tolerance = currentDepth() === 0 ? 1.1 : currentDepth() === 1 ? 0.55 : 0.25;
    const regions = [];

    for (const feature of geoJson.features) {
      const rings = [];
      const geometry = feature.geometry;
      const props = feature.properties || {};

      const collectPolygon = (polygon) => {
        for (const ring of polygon) {
          const projected = ring
            .map((point) => projection(point))
            .filter((point) => point && Number.isFinite(point[0]) && Number.isFinite(point[1]));
          if (projected.length < 4) continue;
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
      const centroid = ringCentroid(rings[0]);
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

      if (state.regions.length <= 45 || region.childrenNum > 0) {
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', region.cx);
        label.setAttribute('y', region.cy * (1 - tilt * 0.15) - height - 2);
        label.setAttribute('class', 'province-label');
        label.setAttribute('font-size', currentDepth() === 0 ? '13' : currentDepth() === 1 ? '11' : '10');
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
      const delta = -event.deltaY * 0.001;
      const oldScale = state.scale;
      state.scale = Math.max(0.5, Math.min(4, state.scale * (1 + delta)));
      const rect = stage.getBoundingClientRect();
      const mx = event.clientX - rect.left - rect.width / 2;
      const my = event.clientY - rect.top - rect.height / 2;
      const factor = state.scale / oldScale;
      state.tx = mx - (mx - state.tx) * factor;
      state.ty = my - (my - state.ty) * factor;
      applyTransform();
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
    });

    window.addEventListener('mousemove', (event) => {
      if (!dragging) return;
      state.tx += event.clientX - lastX;
      state.ty += event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      applyTransform();
    });

    window.addEventListener('mouseup', () => {
      dragging = false;
      stage.classList.remove('dragging');
    });

    document.getElementById('zoom-in').onclick = () => {
      state.scale = Math.min(4, state.scale * 1.2);
      applyTransform();
    };
    document.getElementById('zoom-out').onclick = () => {
      state.scale = Math.max(0.5, state.scale / 1.2);
      applyTransform();
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
