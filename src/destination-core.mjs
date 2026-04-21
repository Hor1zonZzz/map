export function pickRandomItem(items, random = Math.random) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const index = Math.floor(random() * items.length);
  return items[Math.max(0, Math.min(items.length - 1, index))];
}

export function buildBreadcrumbLabel(region) {
  const nodes = Array.isArray(region?.acroutes) ? region.acroutes : [];
  const names = Array.isArray(region?.acrouteNames) ? region.acrouteNames : [];
  if (!nodes.length || !names.length || nodes.length !== names.length) {
    return region?.name || "";
  }
  return names.concat(region.name || "").filter(Boolean).join(" / ");
}

export function formatCoords(lng, lat) {
  return `${Number(lng).toFixed(6)}, ${Number(lat).toFixed(6)}`;
}

export function createAmapUrl(lng, lat, name) {
  const q = encodeURIComponent(name || "目的地");
  return `https://uri.amap.com/marker?position=${lng},${lat}&name=${q}`;
}

export function pickRegionForCurrentDepth(stateLike, random = Math.random) {
  const allRegions = Array.isArray(stateLike?.regions) ? stateLike.regions : [];
  if (allRegions.length === 0) return null;

  const isRegionFilteredIn = stateLike?.isRegionFilteredIn || (() => true);
  const isRegionWithinRadius = stateLike?.isRegionWithinRadius || (() => false);
  const maxDepth = Number(stateLike?.maxDepth ?? 2);
  const currentDepth = Number(stateLike?.currentDepth ?? 0);
  const hasRadiusSelection = Boolean(stateLike?.hasRadiusSelection);

  const visible = allRegions.filter(isRegionFilteredIn);
  const visibleSource = visible.length ? visible : allRegions;
  const radiusPreferred = hasRadiusSelection ? visibleSource.filter(isRegionWithinRadius) : [];
  const source = radiusPreferred.length ? radiusPreferred : visibleSource;
  const canDrill = currentDepth < maxDepth;
  const pool = canDrill ? source.filter((region) => Number(region.childrenNum || 0) > 0) : source;
  return pickRandomItem(pool.length ? pool : source, random);
}

export function pointFeature(geoOps, lngLat) {
  return geoOps.point([Number(lngLat[0]), Number(lngLat[1])]);
}

export function pointInsideFeature(geoOps, lngLat, feature) {
  return geoOps.booleanPointInPolygon(pointFeature(geoOps, lngLat), feature);
}

export function pickRandomImpactLngLat(region, geoOps, random = Math.random, maxAttempts = 300) {
  const feature = region?.feature;
  if (!feature) {
    return Array.isArray(region?.center) ? region.center : Array.isArray(region?.centroid) ? region.centroid : null;
  }

  const [minLng, minLat, maxLng, maxLat] = geoOps.bbox(feature);
  for (let i = 0; i < maxAttempts; i++) {
    const lng = minLng + (maxLng - minLng) * random();
    const lat = minLat + (maxLat - minLat) * random();
    if (pointInsideFeature(geoOps, [lng, lat], feature)) {
      return [lng, lat];
    }
  }

  const safePoint = geoOps.pointOnFeature(feature);
  return safePoint?.geometry?.coordinates || null;
}

export function createFallbackDestination(region, lngLat) {
  return {
    id: `${region.adcode}-random`,
    name: `${region.name} 区域内随机落点`,
    adcode: region.adcode,
    lng: Number(lngLat[0]),
    lat: Number(lngLat[1]),
    kind: "unknown",
    sourceType: "random",
  };
}

export function resolveDestination(region, poiIndex, geoOps, random = Math.random) {
  const pois = poiIndex?.[region.adcode];
  if (Array.isArray(pois) && pois.length > 0) {
    const picked = pickRandomItem(pois, random);
    return {
      id: picked.id,
      name: picked.name,
      adcode: region.adcode,
      lng: Number(picked.lng),
      lat: Number(picked.lat),
      kind: picked.kind || "unknown",
      sourceType: "osm",
    };
  }

  const fallbackCoords = pickRandomImpactLngLat(region, geoOps, random);
  return createFallbackDestination(region, fallbackCoords || region.center || region.centroid || [0, 0]);
}

export function projectLngLatToScreen(projection, lngLat) {
  if (!projection || !Array.isArray(lngLat)) return { x: 0, y: 0 };
  const point = projection(lngLat);
  if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
    return { x: 0, y: 0 };
  }
  return { x: point[0], y: point[1] };
}
