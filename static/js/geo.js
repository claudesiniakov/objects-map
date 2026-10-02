// Геометрия в браузере (скачанная карта): те же правила, что у сервера в backend/app/geo.py —
// проверка Polygon/MultiPolygon в WGS-84, точка маркера внутри контура, площадь на сфере.

const MAX_VERTICES = 50000;

export class GeometryError extends Error {}

/** GeoJSON-геометрия (объект или JSON-строка, можно Feature) → Polygon/MultiPolygon; точка → null. */
export function parseGeometry(value) {
  if (value === null || value === undefined || value === '') return null;
  let g = value;
  if (typeof g === 'string') {
    try { g = JSON.parse(g); } catch { throw new GeometryError('геометрия — не GeoJSON'); }
  }
  if (!g || typeof g !== 'object') throw new GeometryError('геометрия — не GeoJSON');
  if (g.type === 'Feature') g = g.geometry || {};
  if (g.type === 'Point') return null;
  if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') {
    throw new GeometryError(`тип геометрии «${g.type}» не поддерживается (нужен Polygon, MultiPolygon или Point)`);
  }
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  if (!Array.isArray(polys) || !polys.length) throw new GeometryError('у полигона нет координат');
  let vertices = 0;
  const clean = polys.map((poly) => {
    if (!Array.isArray(poly) || !poly.length) throw new GeometryError('полигон без контура');
    return poly.map((ring) => {
      if (!Array.isArray(ring) || ring.length < 3) throw new GeometryError('контур полигона меньше трёх точек');
      const pts = ring.map((pt) => {
        const lon = Number(pt?.[0]);
        const lat = Number(pt?.[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new GeometryError('координаты полигона — не числа');
        if (Math.abs(lon) > 180 || Math.abs(lat) > 90) throw new GeometryError('координаты полигона вне WGS-84 (нужны долгота и широта в градусах)');
        return [lon, lat];
      });
      const [f, l] = [pts[0], pts[pts.length - 1]];
      if (f[0] !== l[0] || f[1] !== l[1]) pts.push([...f]); // замыкаем контур
      if (pts.length < 4) throw new GeometryError('контур полигона меньше трёх точек');
      vertices += pts.length;
      return pts;
    });
  });
  if (vertices > MAX_VERTICES) throw new GeometryError(`слишком подробный полигон: ${vertices} вершин (не больше ${MAX_VERTICES})`);
  return clean.length === 1 ? { type: 'Polygon', coordinates: clean[0] } : { type: 'MultiPolygon', coordinates: clean };
}

const parts = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i += 1) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return a / 2;
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

const inPolygon = (x, y, rings) => inRing(x, y, rings[0]) && !rings.slice(1).some((h) => inRing(x, y, h));

export function contains(g, lon, lat) {
  return parts(g).some((rings) => inPolygon(lon, lat, rings));
}

/** Точка маркера: центр тяжести самого большого контура, а если он снаружи — середина самого широкого
 *  внутреннего отрезка горизонтали через центр. Возвращает [lat, lon]. */
export function labelPoint(g) {
  const rings = parts(g).reduce((best, p) => (Math.abs(ringArea(p[0])) > Math.abs(ringArea(best[0])) ? p : best));
  const outer = rings[0];
  const a = ringArea(outer);
  let cx;
  let cy;
  if (Math.abs(a) < 1e-15) {
    cx = outer.slice(0, -1).reduce((s, p) => s + p[0], 0) / (outer.length - 1);
    cy = outer.slice(0, -1).reduce((s, p) => s + p[1], 0) / (outer.length - 1);
  } else {
    cx = 0;
    cy = 0;
    for (let i = 0; i < outer.length - 1; i += 1) {
      const [x1, y1] = outer[i];
      const [x2, y2] = outer[i + 1];
      const f = x1 * y2 - x2 * y1;
      cx += (x1 + x2) * f;
      cy += (y1 + y2) * f;
    }
    cx /= 6 * a;
    cy /= 6 * a;
  }
  if (inPolygon(cx, cy, rings)) return [cy, cx];
  const xs = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i += 1) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      if ((y1 > cy) !== (y2 > cy)) xs.push(((x2 - x1) * (cy - y1)) / (y2 - y1) + x1);
    }
  }
  xs.sort((p, q) => p - q);
  let best = null;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (!best || xs[i + 1] - xs[i] > best[1] - best[0]) best = [xs[i], xs[i + 1]];
  }
  if (best && inPolygon((best[0] + best[1]) / 2, cy, rings)) return [cy, (best[0] + best[1]) / 2];
  return [outer[0][1], outer[0][0]];
}

/** Площадь на сфере (как turf.area), м². */
export function areaM2(g) {
  const R = 6378137;
  const rad = Math.PI / 180;
  const ring = (cs) => {
    let a = 0;
    for (let i = 0; i < cs.length - 1; i += 1) {
      a += (cs[i + 1][0] - cs[i][0]) * rad * (2 + Math.sin(cs[i][1] * rad) + Math.sin(cs[i + 1][1] * rad));
    }
    return Math.abs((a * R * R) / 2);
  };
  return parts(g).reduce((s, p) => s + ring(p[0]) - p.slice(1).reduce((h, r) => h + ring(r), 0), 0);
}

/** GeoJSON-файл → строки таблицы (как у CSV): центр, геометрия и свойства объектов — колонками. */
export function geojsonToRows(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`файл не читается как GeoJSON: ${e.message}`);
  }
  let features;
  if (Array.isArray(data)) features = data;
  else if (data?.type === 'FeatureCollection') features = data.features || [];
  else if (data?.type === 'Feature') features = [data];
  else throw new Error('ожидается FeatureCollection, Feature или список объектов');
  const crs = data?.crs?.properties?.name || '';
  if (crs && !crs.includes('4326') && !crs.includes('CRS84')) {
    throw new Error(`система координат ${crs} не поддерживается — нужна WGS-84 (EPSG:4326)`);
  }
  const keys = [];
  for (const f of features) for (const k of Object.keys(f?.properties || {})) if (!keys.includes(k)) keys.push(k);
  const cell = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const rows = [['Широта (центр)', 'Долгота (центр)', 'Геометрия (GeoJSON)', ...keys]];
  for (const f of features) {
    const g = f?.geometry || {};
    let lat = '';
    let lon = '';
    let geom = '';
    if (g.type === 'Point') [lon, lat] = (g.coordinates || []).map(String);
    else if (g.type) geom = JSON.stringify(g); // проверка и центр — при разборе строки
    rows.push([lat ?? '', lon ?? '', geom, ...keys.map((k) => cell(f?.properties?.[k]))]);
  }
  return rows;
}
