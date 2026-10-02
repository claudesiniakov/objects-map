import { can, confirmDialog, debounce, esc, fail, fmtCost, fmtDate, fmtNum, logout, modal, plural, toast } from './api.js';
import { csvToObjects, parseCsv, readCsvFile } from './csv.js';
import { geojsonToRows } from './geo.js';
import { createProvider } from './data.js';
import { downloadSnapshot } from './download.js';
import { markerCanvas, markerDataUrl } from './icons.js';

const $ = (id) => document.getElementById(id);
const EMPTY = { type: 'FeatureCollection', features: [] };
const NONE = '__none__'; // значение фильтра «не заполнено»
const MIN_ZONE_PX = 10;
const data = createProvider();

const state = {
  settings: null,
  types: [],
  typeById: new Map(),
  all: EMPTY,
  filtered: [],
  visible: new Set(),
  zones: true,
  source: '',
  polygons: new Map(), // id объекта → GeoJSON-контур
  showPolygons: true,
  geom: '', // фильтр по геометрии: '' — все, 'poly' — только полигоны, 'point' — только точки
  attrNames: [], // поля из настройки filter_attributes
  attrs: [], // выбранное значение по каждому полю: '' — все, NONE — не заполнено
};

let map;
let clusterMarkers = {};
let clustersOnScreen = {};
// Подписи стоимости под одиночными маркерами — пока на экране есть кластеры.
let costLabels = {};
let costLabelsOnScreen = {};
let spider = [];
let hoverPopup;

// ---------------------------------------------------------------- состояние в URL

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const out = {};
  const m = (p.get('map') || '').split('/').map(Number);
  if (m.length === 3 && m.every(Number.isFinite)) out.view = { zoom: m[0], center: [m[2], m[1]] };
  if (p.has('types')) out.types = p.get('types').split(',').filter(Boolean).map(Number);
  if (p.has('zones')) out.zones = p.get('zones') !== '0';
  if (p.has('source')) out.source = p.get('source');
  if (p.has('poly')) out.showPolygons = p.get('poly') !== '0';
  if (['poly', 'point'].includes(p.get('geom'))) out.geom = p.get('geom');
  out.attrs = {};
  for (const [k, v] of p) if (k.startsWith('a.')) out.attrs[k.slice(2)] = v === '-' ? NONE : v;
  return out;
}

function writeHash() {
  if (!map) return;
  const c = map.getCenter();
  const p = new URLSearchParams();
  p.set('map', `${map.getZoom().toFixed(2)}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`);
  if (state.visible.size !== state.types.length) p.set('types', [...state.visible].join(','));
  if (!state.zones) p.set('zones', '0');
  if (state.source) p.set('source', state.source);
  if (!state.showPolygons) p.set('poly', '0');
  if (state.geom) p.set('geom', state.geom);
  state.attrNames.forEach((name, i) => { if (state.attrs[i]) p.set(`a.${name}`, state.attrs[i] === NONE ? '-' : state.attrs[i]); });
  history.replaceState(null, '', `#${p.toString().replace(/%2F/g, '/').replace(/%2C/g, ',')}`);
}

// ---------------------------------------------------------------- данные и фильтры

// Фильтры помимо типа: источник и дополнительные поля.
function passesExtra(f) {
  if (state.source && f.properties.s !== state.source) return false;
  if (state.geom === 'poly' && !f.properties.g) return false;
  if (state.geom === 'point' && f.properties.g) return false;
  for (let i = 0; i < state.attrs.length; i += 1) {
    const want = state.attrs[i];
    if (!want) continue;
    const have = f.properties.a?.[i] ?? null;
    if (want === NONE ? have !== null : have !== want) return false;
  }
  return true;
}

function hasExtraFilters() {
  return Boolean(state.source) || Boolean(state.geom) || state.attrs.some(Boolean);
}

function applyFilter() {
  state.filtered = state.all.features.filter((f) => state.visible.has(f.properties.t) && passesExtra(f));
  $('resetFilters').hidden = !hasExtraFilters();
  clearClusterMarkers();
  clearSpider();
  map.getSource('objects')?.setData({ type: 'FeatureCollection', features: state.filtered });
  updateZones();
  updatePolygons();
  renderLegend();
  writeHash();
}

// Полигоны рисуются для объектов, прошедших фильтры; маркер объекта стоит посередине контура.
function updatePolygons() {
  const src = map?.getSource('polygons');
  if (!src) return;
  const features = [];
  if (state.showPolygons) {
    for (const f of state.filtered) {
      if (!f.properties.g) continue;
      const geometry = state.polygons.get(f.properties.id);
      const t = state.typeById.get(f.properties.t);
      if (geometry) features.push({ type: 'Feature', geometry, properties: { id: f.properties.id, c: t?.color || '#555' } });
    }
  }
  src.setData({ type: 'FeatureCollection', features });
}

async function loadObjects() {
  state.all = await data.objects();
  state.polygons = new Map();
  if (state.all.features.some((f) => f.properties.g)) {
    for (const f of (await data.polygons()).features) state.polygons.set(f.properties.id, f.geometry);
  }
}

function costSummary() {
  let sum = 0;
  let n = 0;
  for (const f of state.filtered) {
    if (typeof f.properties.c === 'number') {
      sum += f.properties.c;
      n += 1;
    }
  }
  return n ? ` · стоимость ${fmtCost(sum)}` : '';
}

function renderLegend() {
  const counts = new Map();
  for (const f of state.all.features) {
    if (!passesExtra(f)) continue;
    counts.set(f.properties.t, (counts.get(f.properties.t) || 0) + 1);
  }
  const legend = $('legend');
  legend.innerHTML = state.types.map((t) => `
    <li>
      <label class="check legend-item">
        <input type="checkbox" data-type="${t.id}" ${state.visible.has(t.id) ? 'checked' : ''}>
        <img class="legend-icon" data-icon="${t.id}" alt="">
        <span class="legend-name">${esc(t.name)}${t.has_radius && t.default_radius_m ? ` <span class="muted small">· ${fmtNum(t.default_radius_m)} м</span>` : ''}</span>
        <span class="legend-count">${fmtNum(counts.get(t.id) || 0)}</span>
      </label>
    </li>`).join('');
  for (const t of state.types) {
    markerDataUrl(t).then((url) => {
      const img = legend.querySelector(`[data-icon="${t.id}"]`);
      if (img) img.src = url;
    });
  }
  const shown = state.filtered.length;
  $('stats').textContent = data.mode === 'snapshot' && !state.all.features.length
    ? 'Объектов нет — нажмите «Импорт CSV / GeoJSON» или перетащите файл в окно'
    : `На карте ${fmtNum(shown)} из ${fmtNum(state.all.features.length)} объектов${costSummary()}`;
}

// ---------------------------------------------------------------- зоны

// Зона рисуется GPU-слоем кругов: радиус в метрах переводится в пиксели выражением от масштаба,
// поэтому при движении карты данные не пересчитываются. k — радиус в пикселях на масштабе 0
// (512-пиксельные тайлы, масштаб Меркатора на широте объекта), minz — масштаб, с которого зона шире MIN_ZONE_PX.
const EARTH_CIRCUMFERENCE_M = 40075016.686;

function zoneFeature(f) {
  const r = f.properties.r;
  const [, lat] = f.geometry.coordinates;
  const k = (r * 512) / (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180));
  const t = state.typeById.get(f.properties.t);
  return {
    type: 'Feature',
    geometry: f.geometry,
    properties: { k, minz: Math.ceil(Math.log2(MIN_ZONE_PX / k)), c: t.color, o: t.fill_opacity },
  };
}

function updateZones() {
  const src = map.getSource('zones');
  if (!src) return;
  const features = state.zones ? state.filtered.filter((f) => f.properties.r).map(zoneFeature) : [];
  // На мелких масштабах зон не видно — не даём MapLibre перебирать их в тайлах.
  const minZoom = features.reduce((m, f) => Math.min(m, f.properties.minz), 24);
  map.setLayerZoomRange('zones', Math.max(0, Math.min(minZoom, 24)), 24);
  src.setData({ type: 'FeatureCollection', features });
}

// ---------------------------------------------------------------- кластеры


function clusterBucket(n) {
  if (n < 10) return { size: 36, cls: 'c-small' };
  if (n < 100) return { size: 44, cls: 'c-medium' };
  return { size: 54, cls: 'c-large' };
}

function shortCount(n) {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace('.0', '')}k`;
  return String(n);
}

function donutElement(props) {
  const total = props.point_count;
  const { size, cls } = clusterBucket(total);
  const parts = state.types
    .map((t) => ({ t, n: props[`t_${t.id}`] || 0 }))
    .filter((p) => p.n > 0)
    .sort((a, b) => b.n - a.n);
  const r = size / 2;
  const r0 = r - 6;
  let acc = 0;
  let paths = '';
  for (const { t, n } of parts) {
    if (parts.length === 1) {
      paths += `<circle cx="${r}" cy="${r}" r="${r - 3}" fill="none" stroke="${t.color}" stroke-width="6"/>`;
      break;
    }
    const a0 = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += n;
    const a1 = (acc / total) * Math.PI * 2 - Math.PI / 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad, a) => `${r + rad * Math.cos(a)} ${r + rad * Math.sin(a)}`;
    paths += `<path d="M${p(r, a0)} A${r} ${r} 0 ${large} 1 ${p(r, a1)} L${p(r0, a1)} A${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z" fill="${t.color}"/>`;
  }
  const el = document.createElement('div');
  el.className = `cluster ${cls}`;
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  const withCost = props.cc > 0;
  el.title = `${fmtNum(total)} ${plural(total, 'объект', 'объекта', 'объектов')}`
    + (withCost ? `\nСтоимость: ${fmtCost(props.cost)}${props.cc < total ? ` (указана у ${fmtNum(props.cc)})` : ''}` : '')
    + `\n${parts.map((p) => `${p.t.name}: ${fmtNum(p.n)}`).join('\n')}`;
  el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${paths}
    <circle cx="${r}" cy="${r}" r="${r0}" class="cluster-core"/></svg><span class="cluster-count">${shortCount(total)}</span>`
    + (withCost ? `<span class="cluster-cost">${fmtCost(props.cost)}</span>` : '');
  return el;
}

function clearClusterMarkers() {
  for (const m of Object.values(clustersOnScreen)) m.remove();
  for (const m of Object.values(costLabelsOnScreen)) m.remove();
  clusterMarkers = {};
  clustersOnScreen = {};
  costLabels = {};
  costLabelsOnScreen = {};
}

function costLabelMarker(coords, cost) {
  const el = document.createElement('div');
  el.className = 'point-cost';
  el.textContent = fmtCost(cost);
  // Маркер объекта стоит остриём на точке — подпись сразу под остриём.
  return new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, 2] }).setLngLat(coords);
}

function updateClusterMarkers() {
  const next = {};
  for (const f of map.querySourceFeatures('objects')) {
    const p = f.properties;
    if (!p.cluster) continue;
    const id = p.cluster_id;
    if (next[id]) continue;
    let marker = clusterMarkers[id];
    if (!marker) {
      const el = donutElement(p);
      const coords = f.geometry.coordinates;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        onClusterClick(id, coords);
      });
      marker = new maplibregl.Marker({ element: el }).setLngLat(coords);
      clusterMarkers[id] = marker;
    }
    next[id] = marker;
    if (!clustersOnScreen[id]) marker.addTo(map);
  }
  for (const id of Object.keys(clustersOnScreen)) {
    if (!next[id]) clustersOnScreen[id].remove();
  }
  clustersOnScreen = next;
  updateCostLabels();
}

function updateCostLabels() {
  const bounds = map.getBounds();
  const clustersVisible = Object.values(clustersOnScreen).some((m) => bounds.contains(m.getLngLat()));
  const next = {};
  if (clustersVisible) {
    for (const f of map.querySourceFeatures('objects')) {
      const p = f.properties;
      if (p.cluster || typeof p.c !== 'number' || next[p.id]) continue;
      const marker = costLabels[p.id] || (costLabels[p.id] = costLabelMarker(f.geometry.coordinates, p.c));
      next[p.id] = marker;
      if (!costLabelsOnScreen[p.id]) marker.addTo(map);
    }
  }
  for (const id of Object.keys(costLabelsOnScreen)) {
    if (!next[id]) costLabelsOnScreen[id].remove();
  }
  costLabelsOnScreen = next;
}

async function onClusterClick(id, coords) {
  const src = map.getSource('objects');
  try {
    const zoom = await src.getClusterExpansionZoom(id);
    if (zoom > state.settings.cluster_max_zoom) {
      const leaves = await src.getClusterLeaves(id, 300, 0);
      spiderfy(coords, leaves);
    } else {
      map.easeTo({ center: coords, zoom: Math.min(zoom + 0.2, 19) });
    }
  } catch (e) {
    fail(e);
  }
}

// ---------------------------------------------------------------- «веер» для объектов в одной точке

function clearSpider() {
  for (const m of spider) m.remove();
  spider = [];
  map?.getSource('spider')?.setData(EMPTY);
}

async function spiderfy(center, features) {
  clearSpider();
  const n = features.length;
  const c = map.project(center);
  const legs = [];
  const offsets = [];
  if (n <= 9) {
    const radius = Math.max(36, n * 9);
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      offsets.push([radius * Math.cos(a), radius * Math.sin(a)]);
    }
  } else {
    let a = 0;
    let radius = 30;
    for (let i = 0; i < n; i += 1) {
      a += 34 / radius + 0.25;
      radius += 30 / (Math.PI * 2) * (34 / radius + 0.25);
      offsets.push([radius * Math.cos(a), radius * Math.sin(a)]);
    }
  }
  features.forEach((f, i) => {
    const pos = map.unproject([c.x + offsets[i][0], c.y + offsets[i][1]]);
    legs.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [center, [pos.lng, pos.lat]] } });
    const t = state.typeById.get(f.properties.t);
    const el = document.createElement('img');
    el.className = 'spider-marker';
    el.title = f.properties.n;
    markerDataUrl(t).then((url) => { el.src = url; });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openCard(f.properties.id, pos);
    });
    spider.push(new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(pos).addTo(map));
  });
  map.getSource('spider').setData({ type: 'FeatureCollection', features: legs });
}

// ---------------------------------------------------------------- карточка объекта

function row(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return `<tr><th>${esc(label)}</th><td>${value}</td></tr>`;
}

// На широком экране карточка открывается всплывающим окном у маркера, на телефоне — нижней панелью.
const narrowScreen = () => window.matchMedia('(max-width: 800px)').matches;
let cardPopup;
let cardSeq = 0;

// Сдвигает карту, чтобы всплывающая карточка целиком помещалась на экране.
function fitCardPopup() {
  if (!cardPopup?.isOpen()) return;
  if (map.isMoving()) {
    map.once('moveend', fitCardPopup); // например, ещё идёт перелёт к найденному объекту
    return;
  }
  const r = cardPopup.getElement().getBoundingClientRect();
  const c = map.getContainer().getBoundingClientRect();
  const m = 12;
  let dx = 0;
  let dy = 0;
  if (r.bottom > c.bottom - m) dy = r.bottom - (c.bottom - m);
  if (r.top - dy < c.top + m) dy = r.top - (c.top + m);
  if (r.right > c.right - m) dx = r.right - (c.right - m);
  if (r.left - dx < c.left + m) dx = r.left - (c.left + m);
  if (dx || dy) map.panBy([dx, dy], { duration: 300 });
}

function closeCard() {
  cardPopup?.remove();
  $('card').hidden = true;
}

const COPY_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>';
const DONE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';

/** Значение моноширинным шрифтом и кнопка-иконка «копировать» рядом. */
function copyable(shown, value) {
  return `<span class="copyable"><span class="mono">${shown}</span><button type="button" class="copy-btn" data-copy="${esc(value)}" title="Копировать" aria-label="Копировать">${COPY_ICON}</button></span>`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Страница с диска или без HTTPS: Clipboard API может быть недоступен — запасной путь через выделение.
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function fmtArea(m2) {
  if (m2 < 10000) return `${fmtNum(Math.round(m2))} м²`;
  const ha = (m2 / 1e4).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  if (m2 < 1e6) return `${ha} га`;
  return `${(m2 / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} км² (${ha} га)`;
}

function cardHtml(o, icon) {
  const radius = o.effective_radius_m
    ? `${fmtNum(o.effective_radius_m)} м${o.radius_m ? '' : ' <span class="muted">(по типу)</span>'}`
    : '';
  const attrs = Object.entries(o.attributes || {}).map(([k, v]) => row(k, esc(v))).join('');
  return `
    <div class="card-head">
      <img src="${icon}" alt="" class="card-icon">
      <div><h2>${esc(o.name)}</h2><div class="muted">${esc(o.type_name)}</div></div>
    </div>
    <table class="kv">
      ${row('ID', o.external_id ? copyable(esc(o.external_id), o.external_id) : '')}
      ${row('Номер договора', o.contract_number ? copyable(esc(o.contract_number), o.contract_number) : '')}
      ${row('Кадастровый номер', o.cadastral_number ? copyable(esc(o.cadastral_number), o.cadastral_number) : '')}
      ${row('Стоимость', o.cost != null ? `${o.cost.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} тыс. ₽${o.cost >= 1000 ? ` <span class="muted">(${fmtCost(o.cost)})</span>` : ''}` : '')}
      ${row('Адрес', esc(o.address))}
      ${row('Координаты', copyable(`${o.lat.toFixed(6)}, ${o.lon.toFixed(6)}`, `${o.lat}, ${o.lon}`))}
      ${row('Радиус', radius)}
      ${row('Площадь', o.area_m2 ? `${fmtArea(o.area_m2)} <span class="muted">(полигон)</span>` : '')}
      ${row('Описание', esc(o.description).replace(/\n/g, '<br>'))}
      ${attrs}
      ${row('Источник', esc(o.source))}
      ${row('Импорт', o.import_file ? `${esc(o.import_file)}, ${fmtDate(o.import_at)}` : '')}
      ${row('Обновлён', fmtDate(o.updated_at))}
    </table>
    ${commentsHtml(o)}
    <div class="card-actions">
      <button class="btn" data-zoom>Приблизить</button>
      ${data.mode === 'live' && can('operator') ? `<a class="btn" href="/admin#objects/${o.id}">Редактировать</a>` : ''}
    </div>`;
}

// ---------------------------------------------------------------- комментарии в карточке

const COMMENTS_OPEN_KEY = 'objmap_comments_open';

function commentsOpen() {
  try { return localStorage.getItem(COMMENTS_OPEN_KEY) === '1'; } catch { return false; }
}

function rememberCommentsOpen(open) {
  try { localStorage.setItem(COMMENTS_OPEN_KEY, open ? '1' : '0'); } catch { /* приватный режим */ }
}

function commentsHtml(o) {
  const count = o.comments_count ?? o.comments?.length ?? 0;
  return `
    <details class="comments" ${commentsOpen() ? 'open' : ''}>
      <summary>Комментарии <span class="comment-count">${count}</span></summary>
      ${data.canComment ? `
        <form class="comment-form">
          <textarea rows="2" maxlength="2000" placeholder="Комментарий… (Ctrl+Enter — отправить)" required></textarea>
          <button class="btn small primary" type="submit">Добавить</button>
        </form>` : '<p class="muted small">В выгрузке комментарии только для чтения.</p>'}
      <ul class="comment-list"><li class="muted small">Загрузка…</li></ul>
    </details>`;
}

function renderComments(list, items) {
  list.innerHTML = items.length
    ? items.map((c) => `
      <li>
        <div class="comment-meta"><b>${esc(c.author)}</b> · ${fmtDate(c.created_at)}
          ${c.can_delete ? `<button class="link-btn" data-del="${c.id}">удалить</button>` : ''}</div>
        <div class="comment-text">${esc(c.text).replace(/\n/g, '<br>')}</div>
      </li>`).join('')
    : '<li class="muted small">Комментариев пока нет</li>';
}

function setupComments(box, o) {
  const det = box.querySelector('details.comments');
  const list = det.querySelector('.comment-list');
  const count = det.querySelector('.comment-count');
  let items = null;
  const show = () => { renderComments(list, items); count.textContent = items.length; };
  const load = async () => {
    try {
      items = await data.comments(o.id);
      show();
    } catch (e) {
      list.innerHTML = `<li class="form-error">${esc(e.message)}</li>`;
    }
  };
  det.addEventListener('toggle', () => {
    rememberCommentsOpen(det.open);
    if (det.open && !items) load().then(() => requestAnimationFrame(fitCardPopup));
    else requestAnimationFrame(fitCardPopup);
  });
  if (det.open) load();

  const form = det.querySelector('.comment-form');
  if (form) {
    const area = form.querySelector('textarea');
    // Клавиши в поле ввода не должны управлять картой (+/− масштабируют, стрелки двигают).
    area.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = area.value.trim();
      if (!text) return;
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        const c = await data.addComment(o.id, text);
        items = [c, ...(items || [])];
        show();
        area.value = '';
      } catch (ex) {
        fail(ex);
      } finally {
        btn.disabled = false;
      }
    });
  }
  list.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    if (!(await confirmDialog('Удалить комментарий?', 'Комментарий будет удалён без возможности восстановления.', 'Удалить'))) return;
    try {
      await data.deleteComment(Number(b.dataset.del));
      items = items.filter((c) => c.id !== Number(b.dataset.del));
      show();
    } catch (ex) {
      fail(ex);
    }
  });
}

/** Открывает карточку объекта. at — точка привязки окна (для «веера» — место маркера в веере). */
async function openCard(id, at) {
  const seq = ++cardSeq;
  const box = document.createElement('div');
  box.className = 'card-content';
  box.innerHTML = '<p class="muted">Загрузка…</p>';
  const inPanel = narrowScreen();
  closeCard();
  hoverPopup?.remove();
  if (inPanel) {
    $('cardBody').replaceChildren(box);
    $('card').hidden = false;
  }
  try {
    const o = await data.object(id);
    if (seq !== cardSeq) return; // пока грузилось, открыли другую карточку
    const t = state.typeById.get(o.type_id);
    box.innerHTML = cardHtml(o, t ? await markerDataUrl(t) : '');
    box.querySelector('[data-zoom]').addEventListener('click', () => {
      map.flyTo({ center: [o.lon, o.lat], zoom: Math.max(map.getZoom(), 16) });
    });
    box.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      const ok = await copyText(b.dataset.copy);
      b.innerHTML = ok ? DONE_ICON : COPY_ICON;
      b.classList.toggle('copied', ok);
      b.title = ok ? 'Скопировано' : 'Не удалось скопировать';
      setTimeout(() => { b.innerHTML = COPY_ICON; b.classList.remove('copied'); b.title = 'Копировать'; }, 1500);
    }));
    setupComments(box, o);
    if (!inPanel) {
      cardPopup = new maplibregl.Popup({ offset: [0, -38], maxWidth: '380px', className: 'card-popup', focusAfterOpen: false })
        .setLngLat(at ?? [o.lon, o.lat])
        .setDOMContent(box)
        .addTo(map);
      requestAnimationFrame(fitCardPopup);
    }
  } catch (e) {
    box.innerHTML = `<p class="form-error">${esc(e.message)}</p>`;
    if (!inPanel) {
      cardPopup = new maplibregl.Popup({ offset: [0, -38], className: 'card-popup' }).setLngLat(at ?? map.getCenter()).setDOMContent(box).addTo(map);
    }
  }
}

// ---------------------------------------------------------------- поиск

// ---------------------------------------------------------------- метки: найденный адрес и личные сохранённые метки

const PIN_COLORS = ['#7b1fa2', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#00897b', '#1e6fd9', '#37474f'];
const PIN_RADII = [0, 100, 300, 500, 1000, 3000];
const PINS_SHOWN_KEY = 'objmap_pins_shown';
// Метка: { id (null — не сохранена), name, address, lat, lon, color, radius_m, marker }
let searchPin = null;
let savedPins = [];
let showSavedPins = true;

function pinSvg(color) {
  return `<svg viewBox="0 0 30 40" width="30" height="40" aria-hidden="true">
    <path d="M15 38.5C13 34 3 25 3 14a12 12 0 0 1 24 0c0 11-10 20-12 24.5z" fill="${color}" stroke="#fff" stroke-width="2"/>
    <circle cx="15" cy="14" r="6.5" fill="#fff"/><circle cx="15" cy="14" r="3" fill="${color}"/></svg>`;
}

function radiusLabel(r) {
  if (!r) return 'Нет';
  return r >= 1000 ? `${r / 1000} км` : `${r} м`;
}

function shortAddress(name) {
  return String(name || '').split(', ').slice(0, 2).join(', ');
}

function visiblePins() {
  return [...(showSavedPins ? savedPins : []), ...(searchPin ? [searchPin] : [])];
}

function updatePinZones() {
  const src = map.getSource('pin-zone');
  if (!src) return;
  const features = visiblePins().filter((p) => p.radius_m > 0).map((p) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    properties: { k: (p.radius_m * 512) / (EARTH_CIRCUMFERENCE_M * Math.cos((p.lat * Math.PI) / 180)), c: p.color },
  }));
  src.setData({ type: 'FeatureCollection', features });
}

function makePinMarker(p) {
  const el = document.createElement('div');
  el.className = 'search-pin';
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    openPinPopup(p);
  });
  p.marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([p.lon, p.lat]);
  refreshPinMarker(p);
}

function refreshPinMarker(p) {
  const el = p.marker.getElement();
  el.innerHTML = pinSvg(p.color);
  el.classList.toggle('saved', Boolean(p.id));
  el.title = p.id ? `${p.name}\nМоя метка — нажмите, чтобы изменить` : `${p.name}\nНажмите, чтобы задать радиус, цвет или сохранить`;
}

function renderSavedPins() {
  if (!data.canSavePins) return;
  for (const p of savedPins) {
    if (showSavedPins) p.marker.addTo(map);
    else p.marker.remove();
  }
  $('pinsBlock').hidden = false;
  $('pinsToggle').checked = showSavedPins;
  $('pinsCount').textContent = savedPins.length ? `(${savedPins.length})` : '';
  $('pinList').innerHTML = savedPins.length
    ? savedPins.map((p) => `<li>
        <button type="button" class="pin-go" data-pin="${p.id}" title="${esc(p.address || p.name)}">
          <span class="pin-dot" style="background:${esc(p.color)}"></span><span class="pin-name">${esc(p.name)}</span>
          ${p.radius_m ? `<span class="muted small">${radiusLabel(p.radius_m)}</span>` : ''}</button>
        <button type="button" class="pin-del" data-del-pin="${p.id}" title="Удалить метку" aria-label="Удалить метку">×</button>
      </li>`).join('')
    : '<li class="muted small">Найдите адрес и нажмите «Сохранить метку»</li>';
  updatePinZones();
}

async function loadSavedPins() {
  if (!data.canSavePins) return;
  try { showSavedPins = localStorage.getItem(PINS_SHOWN_KEY) !== '0'; } catch { /* приватный режим */ }
  savedPins = (await data.pins()).map((p) => ({ ...p }));
  savedPins.forEach(makePinMarker);
  renderSavedPins();
}

function setShowSavedPins(show) {
  showSavedPins = show;
  try { localStorage.setItem(PINS_SHOWN_KEY, show ? '1' : '0'); } catch { /* приватный режим */ }
  renderSavedPins();
}

function removeSearchPin() {
  if (cardPopup && searchPin && cardPopup === searchPin.popup) closeCard();
  searchPin?.marker.remove();
  searchPin = null;
  updatePinZones();
}

function setSearchPin({ lon, lat, name }) {
  const keep = searchPin ? { color: searchPin.color, radius_m: searchPin.radius_m } : { color: PIN_COLORS[0], radius_m: 0 };
  removeSearchPin();
  searchPin = { id: null, name: shortAddress(name), address: name, lon, lat, ...keep };
  makePinMarker(searchPin);
  searchPin.marker.addTo(map);
  updatePinZones();
}

const pinPayload = (p) => ({ name: p.name, address: p.address, lat: p.lat, lon: p.lon, color: p.color, radius_m: p.radius_m });

async function deleteSavedPin(p) {
  if (!(await confirmDialog('Удалить метку?', `Метка «${p.name}» будет удалена.`, 'Удалить'))) return;
  try {
    await data.deletePin(p.id);
    if (cardPopup && cardPopup === p.popup) closeCard();
    p.marker.remove();
    savedPins = savedPins.filter((x) => x !== p);
    renderSavedPins();
    toast('Метка удалена', 'success');
  } catch (e) {
    fail(e);
  }
}

function openPinPopup(p) {
  const saved = Boolean(p.id);
  const box = document.createElement('div');
  box.className = 'card-content pin-card';
  box.innerHTML = `
    <div class="card-head">${pinSvg(p.color)}<div><h2>${saved ? 'Моя метка' : 'Найденный адрес'}</h2>
      <div class="muted small">${esc(p.address || '')}</div></div></div>
    ${saved || data.canSavePins ? `<label class="pin-name-field">Название<input data-name maxlength="200" value="${esc(p.name)}"></label>` : ''}
    <table class="kv">${row('Координаты', copyable(`${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`, `${p.lat}, ${p.lon}`))}</table>
    <div class="pin-field">
      <div class="pin-label">Радиус зоны</div>
      <div class="chips">${PIN_RADII.map((r) => `<button type="button" class="chip-btn ${r === p.radius_m ? 'active' : ''}" data-r="${r}">${radiusLabel(r)}</button>`).join('')}</div>
      <label class="pin-inline">или <input type="number" min="0" max="100000" step="10" value="${p.radius_m || ''}" placeholder="0" data-radius> м</label>
    </div>
    <div class="pin-field">
      <div class="pin-label">Цвет</div>
      <div class="swatches">${PIN_COLORS.map((c) => `<button type="button" class="swatch-btn ${c === p.color ? 'active' : ''}" data-c="${c}" style="background:${c}" title="${c}" aria-label="Цвет ${c}"></button>`).join('')}
        <input type="color" value="${p.color}" data-color title="Свой цвет" aria-label="Свой цвет"></div>
    </div>
    ${saved
    ? '<p class="muted small pin-status" data-status>Видна только вам. Изменения сохраняются автоматически.</p><div class="card-actions"><button class="btn danger" data-delete>Удалить метку</button></div>'
    : data.canSavePins
      ? '<p class="muted small">Метка не сохранена: исчезнет при новом поиске адреса или перезагрузке страницы.</p><div class="card-actions"><button class="btn primary" data-save>Сохранить метку</button><button class="btn" data-remove>Убрать</button></div>'
      : '<p class="muted small">Метка не сохраняется: исчезнет при новом поиске адреса или перезагрузке страницы.</p><div class="card-actions"><button class="btn" data-remove>Убрать метку</button></div>'}`;

  const status = box.querySelector('[data-status]');
  let saveTimer;
  const autosave = () => {
    if (!p.id) return;
    clearTimeout(saveTimer);
    if (status) status.textContent = 'Сохраняю…';
    saveTimer = setTimeout(async () => {
      try {
        await data.updatePin(p.id, pinPayload(p));
        if (status) status.textContent = 'Сохранено. Метка видна только вам.';
      } catch (e) {
        if (status) status.textContent = `Не сохранено: ${e.message}`;
      }
    }, 500);
  };
  const changed = () => {
    refreshPinMarker(p);
    box.querySelector('.card-head svg').outerHTML = pinSvg(p.color);
    box.querySelectorAll('[data-r]').forEach((b) => b.classList.toggle('active', Number(b.dataset.r) === p.radius_m));
    box.querySelectorAll('[data-c]').forEach((b) => b.classList.toggle('active', b.dataset.c === p.color));
    box.querySelector('[data-color]').value = p.color;
    if (p.id) renderSavedPins();
    else updatePinZones();
    autosave();
  };

  box.addEventListener('keydown', (e) => e.stopPropagation()); // цифры и +/− в полях не управляют картой
  box.addEventListener('click', async (e) => {
    const r = e.target.closest('[data-r]');
    const c = e.target.closest('[data-c]');
    if (r) {
      p.radius_m = Number(r.dataset.r);
      box.querySelector('[data-radius]').value = p.radius_m || '';
      changed();
    } else if (c) {
      p.color = c.dataset.c;
      changed();
    } else if (e.target.closest('[data-remove]')) {
      removeSearchPin();
    } else if (e.target.closest('[data-delete]')) {
      deleteSavedPin(p);
    } else if (e.target.closest('[data-save]')) {
      const btn = e.target.closest('[data-save]');
      btn.disabled = true;
      try {
        const res = await data.createPin(pinPayload(p));
        Object.assign(p, res);
        searchPin = null;
        savedPins.push(p);
        savedPins.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        if (!showSavedPins) setShowSavedPins(true);
        refreshPinMarker(p);
        renderSavedPins();
        toast('Метка сохранена — она в разделе «Мои метки» в фильтрах', 'success');
        openPinPopup(p);
      } catch (ex) {
        btn.disabled = false;
        fail(ex);
      }
    }
  });
  box.querySelector('[data-radius]').addEventListener('input', (e) => {
    const v = Math.round(Number(e.target.value));
    p.radius_m = Number.isFinite(v) ? Math.max(0, Math.min(100000, v)) : 0;
    changed();
  });
  box.querySelector('[data-color]').addEventListener('input', (e) => { p.color = e.target.value; changed(); });
  box.querySelector('[data-name]')?.addEventListener('input', (e) => {
    const v = e.target.value.trim();
    if (!v) return; // пустое название не сохраняем
    p.name = v;
    refreshPinMarker(p);
    if (p.id) renderSavedPins();
    autosave();
  });
  box.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const ok = await copyText(b.dataset.copy);
    b.innerHTML = ok ? DONE_ICON : COPY_ICON;
    setTimeout(() => { b.innerHTML = COPY_ICON; }, 1500);
  }));

  closeCard();
  p.popup = new maplibregl.Popup({ offset: [0, -40], maxWidth: '360px', className: 'card-popup', focusAfterOpen: false })
    .setLngLat([p.lon, p.lat]).setDOMContent(box).addTo(map);
  cardPopup = p.popup; // сдвиг карты под окно — как у карточки объекта
  requestAnimationFrame(fitCardPopup);
}

function setupPinsPanel() {
  if (!data.canSavePins) return;
  $('pinsToggle').addEventListener('change', (e) => setShowSavedPins(e.target.checked));
  $('pinList').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del-pin]');
    const go = e.target.closest('[data-pin]');
    if (del) {
      const p = savedPins.find((x) => x.id === Number(del.dataset.delPin));
      if (p) deleteSavedPin(p);
    } else if (go) {
      const p = savedPins.find((x) => x.id === Number(go.dataset.pin));
      if (!p) return;
      if (!showSavedPins) setShowSavedPins(true);
      map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 15) });
      openPinPopup(p);
    }
  });
}

// ---------------------------------------------------------------- поиск: объекты и адреса

function objectResults(items) {
  return items.map((o) => `<li><button data-id="${o.id}" data-lon="${o.lon}" data-lat="${o.lat}" data-type="${o.type_id}">
    <b>${esc(o.name)}</b><span class="muted small">${esc(o.type_name)}${o.address ? ` · ${esc(o.address)}` : ''}${o.cadastral_number ? ` · КН ${esc(o.cadastral_number)}` : ''}${o.contract_number ? ` · договор ${esc(o.contract_number)}` : ''}</span></button></li>`).join('');
}

function setupSearch() {
  const input = $('searchInput');
  const list = $('searchResults');
  let objects = [];
  let addresses = null; // null — адрес ещё не искали; [] — не найден
  let addrQuery = '';

  const render = () => {
    const q = input.value.trim();
    let html = objects.length ? `<li class="search-section">Объекты</li>${objectResults(objects)}` : '';
    if (addresses && addrQuery === q) {
      html += '<li class="search-section">Адреса</li>';
      html += addresses.length
        ? addresses.map((a, i) => `<li><button data-addr="${i}"><b>${esc(a.name.split(', ').slice(0, 2).join(', '))}</b><span class="muted small">${esc(a.name)}</span></button></li>`).join('')
        : '<li class="muted empty">Адрес не найден</li>';
    } else if (q.length >= 3) {
      html += `<li><button data-geocode class="geocode-btn"><b>Найти адрес «${esc(q)}»</b><span class="muted small">Enter — поиск по карте OpenStreetMap</span></button></li>`;
    }
    list.innerHTML = html || '<li class="muted empty">Ничего не найдено</li>';
    list.hidden = false;
  };

  const runObjects = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) {
      list.hidden = true;
      return;
    }
    try {
      objects = await data.search(q);
      render();
    } catch (e) {
      fail(e);
    }
  }, 250);

  const runGeocode = async () => {
    const q = input.value.trim();
    if (q.length < 3) return;
    addrQuery = q;
    addresses = null;
    list.innerHTML = `${objects.length ? `<li class="search-section">Объекты</li>${objectResults(objects)}` : ''}<li class="muted empty">Ищу адрес…</li>`;
    list.hidden = false;
    try {
      const b = map.getBounds();
      const viewbox = [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].map((v) => v.toFixed(4)).join(',');
      const found = await data.geocode(q, viewbox);
      if (addrQuery !== q) return; // запрос уже сменился
      addresses = found;
      render();
    } catch (e) {
      addresses = null;
      list.innerHTML = `<li class="form-error empty">${esc(e.message)}</li>`;
    }
  };

  input.addEventListener('input', () => {
    addresses = null;
    runObjects();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runGeocode();
    } else if (e.key === 'Escape') {
      list.hidden = true;
    }
  });
  input.addEventListener('focus', () => { if (list.children.length && input.value.trim().length >= 2) list.hidden = false; });
  document.addEventListener('click', (e) => { if (!$('search').contains(e.target)) list.hidden = true; });
  list.addEventListener('click', (e) => {
    if (e.target.closest('[data-geocode]')) {
      runGeocode();
      return;
    }
    const addr = e.target.closest('[data-addr]');
    if (addr) {
      const a = addresses[Number(addr.dataset.addr)];
      list.hidden = true;
      const [w, s, ea, n] = a.bbox || [];
      // Небольшой объект (дом, улица) — по его границам, иначе — на адрес с приближением.
      if (a.bbox && Math.abs(ea - w) < 0.05 && Math.abs(n - s) < 0.05) {
        map.fitBounds([[w, s], [ea, n]], { padding: 120, maxZoom: 17 });
      } else {
        map.flyTo({ center: [a.lon, a.lat], zoom: Math.max(map.getZoom(), a.bbox && Math.abs(ea - w) > 0.5 ? 11 : 15) });
      }
      setSearchPin({ lon: a.lon, lat: a.lat, name: a.name });
      toast(data.canSavePins ? 'Метка поставлена — нажмите на неё, чтобы задать радиус, цвет или сохранить' : 'Метка поставлена — нажмите на неё, чтобы задать радиус и цвет', 'info', 5000);
      return;
    }
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    list.hidden = true;
    const typeId = Number(b.dataset.type);
    if (!state.visible.has(typeId)) {
      state.visible.add(typeId);
      applyFilter();
    }
    if (hasExtraFilters()) resetFilters();
    map.flyTo({ center: [Number(b.dataset.lon), Number(b.dataset.lat)], zoom: Math.max(17, map.getZoom()) });
    openCard(Number(b.dataset.id));
  });
}

// ---------------------------------------------------------------- фильтры по полям

async function renderAttrFilters() {
  const lists = await Promise.all(
    state.attrNames.map((name) => data.attributeValues(name)),
  );
  $('attrFilters').innerHTML = state.attrNames.map((name, i) => {
    const values = lists[i];
    const empty = values.find((v) => v.value === null);
    const current = state.attrs[i];
    const known = !current || current === NONE || values.some((v) => v.value === current);
    return `<label>${esc(name)}<select data-attr="${i}">
      <option value="">Все</option>
      ${values.filter((v) => v.value !== null).map((v) => `<option value="${esc(v.value)}">${esc(v.value)} (${fmtNum(v.objects)})</option>`).join('')}
      ${empty ? `<option value="${NONE}">— не заполнено (${fmtNum(empty.objects)})</option>` : ''}
      ${known ? '' : `<option value="${esc(current)}">${esc(current)} (0)</option>`}
    </select></label>`;
  }).join('');
  $('attrFilters').querySelectorAll('select').forEach((s) => { s.value = state.attrs[Number(s.dataset.attr)]; });
}

function resetFilters() {
  state.source = '';
  $('sourceSelect').value = '';
  state.geom = '';
  $('geomSelect').value = '';
  state.attrs = state.attrNames.map(() => '');
  $('attrFilters').querySelectorAll('select').forEach((s) => { s.value = ''; });
  applyFilter();
}

// ---------------------------------------------------------------- типы и источник объектов

function setTypes(types) {
  state.types = types;
  state.typeById = new Map(types.map((t) => [t.id, t]));
}

async function addTypeImages() {
  await Promise.all(state.types.map(async (t) => {
    if (map.hasImage(`type-${t.id}`)) return;
    const canvas = await markerCanvas(t);
    const ctx = canvas.getContext('2d');
    map.addImage(`type-${t.id}`, ctx.getImageData(0, 0, canvas.width, canvas.height), { pixelRatio: 2 });
  }));
}

// Счётчики по типам для колец кластеров задаются при создании источника — при новых типах источник пересоздаётся.
function setupObjectsSource() {
  if (map.getLayer('points')) map.removeLayer('points');
  if (map.getSource('objects')) map.removeSource('objects');
  clearClusterMarkers();
  const clusterProperties = {};
  for (const t of state.types) clusterProperties[`t_${t.id}`] = ['+', ['case', ['==', ['get', 't'], t.id], 1, 0]];
  const hasCost = ['==', ['typeof', ['get', 'c']], 'number'];
  clusterProperties.cost = ['+', ['case', hasCost, ['get', 'c'], 0]]; // сумма стоимости, тыс. руб.
  clusterProperties.cc = ['+', ['case', hasCost, 1, 0]]; // сколько объектов со стоимостью
  map.addSource('objects', {
    type: 'geojson',
    data: EMPTY,
    cluster: true,
    clusterRadius: state.settings.cluster_radius,
    clusterMaxZoom: state.settings.cluster_max_zoom,
    clusterProperties,
  });
  map.addLayer({
    id: 'points',
    type: 'symbol',
    source: 'objects',
    filter: ['!', ['has', 'point_count']],
    layout: {
      'icon-image': ['concat', 'type-', ['to-string', ['get', 't']]],
      'icon-anchor': 'bottom',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
}

function renderSources(sources) {
  const sel = $('sourceSelect');
  sel.innerHTML = '<option value="">Все источники</option>'
    + sources.map((s) => `<option value="${esc(s.source)}">${esc(s.source)} (${fmtNum(s.objects)})</option>`).join('');
  sel.value = state.source;
  if (sel.value !== state.source) state.source = '';
}

// ---------------------------------------------------------------- импорт CSV (скачанная страница)

function askImportMode(fileName, count, existing) {
  return new Promise((resolve) => {
    const m = modal('Импорт', `<p>В файле «${esc(fileName)}» объектов: <b>${fmtNum(count)}</b>.
      Сейчас на карте ${fmtNum(existing)}. Что сделать?</p>
      <p class="muted small">«Добавить» обновляет объекты с тем же ID и добавляет новые.</p>`, {
      actions: [
        { label: 'Отмена', onClick: () => resolve(null) },
        { label: 'Добавить', onClick: () => resolve('add') },
        { label: 'Заменить все', kind: 'primary', onClick: () => resolve('replace') },
      ],
    });
    m.querySelector('[data-close]').addEventListener('click', () => resolve(null));
  });
}

function showImportReport(fileName, result, unknownTypes, isGeo = false) {
  const { objects, errors } = result;
  // В CSV — номер строки как в Excel; в GeoJSON строк нет — номер объекта в файле (строка 1 — заголовки).
  const where = (e) => (isGeo ? `Объект ${e.row - 1}` : `Строка ${e.row}`);
  const list = errors.slice(0, 200).map((e) => `<li>${where(e)}: ${esc(e.message)}</li>`).join('');
  modal('Импорт завершён', `
    <p>Из «${esc(fileName)}» загружено объектов: <b>${fmtNum(objects.length)}</b>.</p>
    ${unknownTypes.length ? `<p>Типов нет в справочнике, показаны серым: ${unknownTypes.map((t) => `«${esc(t.name)}»`).join(', ')}.</p>` : ''}
    ${errors.length ? `<p>Замечания (${fmtNum(errors.length)}):</p><ul class="import-errors">${list}</ul>
      ${errors.length > 200 ? `<p class="muted small">Показаны первые 200.</p>` : ''}` : ''}`, {
    actions: [{ label: 'Закрыть', kind: 'primary' }],
  });
}

async function importCsv(file) {
  const isGeo = /\.(geo)?json$/i.test(file.name);
  if (!isGeo && !/\.(csv|txt)$/i.test(file.name)) {
    toast('Нужен файл CSV или GeoJSON', 'error');
    return;
  }
  try {
    const text = await readCsvFile(file);
    const rows = isGeo ? geojsonToRows(text) : parseCsv(text);
    const result = csvToObjects(rows, data.rawTypes(), data.nextId(), file.name);
    if (!result.objects.length) {
      showImportReport(file.name, result, [], isGeo);
      return;
    }
    let mode = 'replace';
    if (data.count()) {
      mode = await askImportMode(file.name, result.objects.length, data.count());
      if (!mode) return;
    }
    data.importObjects(result.objects, result.newTypes, mode === 'replace');
    const knownIds = new Set(state.types.map((t) => t.id));
    setTypes(await data.types());
    const typesChanged = state.types.length !== knownIds.size || state.types.some((t) => !knownIds.has(t.id));
    await addTypeImages();
    if (typesChanged) setupObjectsSource();
    state.visible = new Set(state.types.map((t) => t.id));
    state.source = '';
    state.attrs = state.attrNames.map(() => '');
    renderSources(await data.sources());
    await loadObjects();
    await renderAttrFilters();
    applyFilter();
    fitAll();
    $('snapshotInfo').textContent = `${$('snapshotInfo').textContent.split(' · ')[0]} · файл: ${file.name}`;
    const unknown = state.types.filter((t) => t.unknown && result.newTypes.some((n) => n.id === t.id));
    if (result.errors.length || unknown.length) showImportReport(file.name, result, unknown, isGeo);
    else toast(`Загружено объектов: ${fmtNum(result.objects.length)}`, 'success');
  } catch (e) {
    toast(`Не удалось загрузить ${isGeo ? 'GeoJSON' : 'CSV'}: ${e.message}`, 'error', 8000);
  }
}

function setupCsvImport() {
  const input = $('csvInput');
  $('importCsvBtn').hidden = false;
  $('importCsvBtn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files[0]) importCsv(input.files[0]);
    input.value = '';
  });
  // Файл можно просто перетащить в окно.
  let depth = 0;
  const over = $('dropOverlay');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth += 1; over.hidden = false; } });
  document.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) over.hidden = true; });
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    over.hidden = true;
    if (e.dataTransfer.files[0]) importCsv(e.dataTransfer.files[0]);
  });
}

// ---------------------------------------------------------------- инициализация

function fitAll() {
  if (!state.filtered.length) return;
  const b = new maplibregl.LngLatBounds();
  for (const f of state.filtered) b.extend(f.geometry.coordinates);
  map.fitBounds(b, { padding: 60, maxZoom: 16, duration: 600 });
}

function setupHeader(user) {
  if (data.mode === 'live') {
    $('userName').textContent = user.full_name || user.login;
    $('adminLink').hidden = !can('operator');
    $('logoutBtn').addEventListener('click', logout);
    return;
  }
  // Скачанная страница: без входа, панели управления и повторной выгрузки.
  const m = data.meta;
  $('adminLink').hidden = true;
  $('logoutBtn').hidden = true;
  $('downloadBtn').hidden = true;
  $('userName').hidden = true;
  const info = $('snapshotInfo');
  info.hidden = false;
  info.textContent = `Выгрузка от ${fmtDate(m.created_at)}`;
  info.title = [
    m.created_by && `Выгрузил: ${m.created_by}`,
    m.filters ? `Фильтры при выгрузке — ${m.filters}` : 'Без фильтров',
    `Источник: ${m.origin}`,
  ].filter(Boolean).join('\n');
}

async function init() {
  const user = await data.init();
  setupHeader(user);

  const [settings, types, sources] = await Promise.all([data.settings(), data.types(), data.sources()]);
  state.settings = settings;
  setTypes(types);
  const fromHash = readHash();
  // В выгрузке видны все типы: в неё попали только объекты, видимые в момент скачивания.
  const defaultTypes = data.mode === 'snapshot' ? types : types.filter((t) => t.visible_default);
  state.visible = new Set(fromHash.types ?? defaultTypes.map((t) => t.id));
  const startView = fromHash.view ?? data.meta?.view;
  state.zones = fromHash.zones ?? true;
  state.source = fromHash.source ?? '';
  state.showPolygons = fromHash.showPolygons ?? true;
  state.geom = fromHash.geom ?? '';
  $('polygonsToggle').checked = state.showPolygons;
  $('geomSelect').value = state.geom;
  $('zonesToggle').checked = state.zones;
  renderSources(sources);
  state.attrNames = settings.filter_attributes || [];
  state.attrs = state.attrNames.map((name) => fromHash.attrs[name] ?? '');
  await renderAttrFilters();

  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          maxzoom: 19,
          attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">участники OpenStreetMap</a>',
        },
      },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    },
    center: startView?.center ?? [settings.center_lon, settings.center_lat],
    zoom: startView?.zoom ?? settings.zoom,
    maxZoom: 19,
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

  await Promise.all([new Promise((r) => map.on('load', r)), loadObjects()]);

  await addTypeImages();

  map.addSource('zones', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'zones',
    type: 'circle',
    source: 'zones',
    filter: ['>=', ['zoom'], ['get', 'minz']],
    paint: {
      'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 0, ['get', 'k'], 24, ['*', ['get', 'k'], 2 ** 24]],
      'circle-color': ['get', 'c'],
      'circle-opacity': ['get', 'o'],
      'circle-stroke-color': ['get', 'c'],
      'circle-stroke-width': 1.5,
      'circle-stroke-opacity': 0.9,
      'circle-pitch-alignment': 'map',
    },
  });
  map.addSource('polygons', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'polygons-fill', type: 'fill', source: 'polygons', paint: { 'fill-color': ['get', 'c'], 'fill-opacity': 0.18 } });
  map.addLayer({ id: 'polygons-line', type: 'line', source: 'polygons', paint: { 'line-color': ['get', 'c'], 'line-width': 2, 'line-opacity': 0.9 } });
  map.addSource('pin-zone', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'pin-zone',
    type: 'circle',
    source: 'pin-zone',
    paint: {
      'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 0, ['get', 'k'], 24, ['*', ['get', 'k'], 2 ** 24]],
      'circle-color': ['get', 'c'],
      'circle-opacity': 0.18,
      'circle-stroke-color': ['get', 'c'],
      'circle-stroke-width': 2,
      'circle-pitch-alignment': 'map',
    },
  });
  map.addSource('spider', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'spider-legs', type: 'line', source: 'spider', paint: { 'line-color': '#555', 'line-width': 1.2, 'line-opacity': 0.7 } });
  setupObjectsSource();

  map.on('render', () => {
    if (map.getSource('objects') && map.isSourceLoaded('objects')) updateClusterMarkers();
  });
  map.on('moveend', writeHash);
  // Подложка грузится из интернета; если тайлы недоступны, объекты всё равно видны — предупреждаем один раз.
  let tilesWarned = false;
  map.on('error', (e) => {
    if (tilesWarned || e.sourceId !== 'osm') return;
    tilesWarned = true;
    toast('Не загрузилась подложка карты (нет доступа к tile.openstreetmap.org) — объекты показаны без неё', 'error', 8000);
  });
  map.on('zoomstart', clearSpider);
  map.on('click', (e) => {
    if (!map.queryRenderedFeatures(e.point, { layers: ['points'] }).length) clearSpider();
  });

  hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: [0, -36], className: 'hover-popup' });
  map.on('mousemove', 'points', (e) => {
    map.getCanvas().style.cursor = 'pointer';
    if (cardPopup?.isOpen()) return; // подсказка не перекрывает открытую карточку
    const f = e.features[0];
    const t = state.typeById.get(f.properties.t);
    hoverPopup.setLngLat(f.geometry.coordinates).setHTML(`<b>${esc(f.properties.n)}</b><br><span class="muted">${esc(t?.name)}</span>`).addTo(map);
  });
  map.on('mouseleave', 'points', () => {
    map.getCanvas().style.cursor = '';
    hoverPopup.remove();
  });
  map.on('click', 'polygons-fill', (e) => {
    // Маркер поверх полигона открывает свою карточку сам.
    if (map.queryRenderedFeatures(e.point, { layers: ['points'] }).length) return;
    openCard(e.features[0].properties.id);
  });
  map.on('mouseenter', 'polygons-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'polygons-fill', () => { map.getCanvas().style.cursor = ''; });
  map.on('click', 'points', (e) => {
    const f = e.features[0];
    const p = map.project(f.geometry.coordinates);
    const near = map.queryRenderedFeatures([[p.x - 4, p.y - 4], [p.x + 4, p.y + 4]], { layers: ['points'] });
    const uniq = [...new Map(near.map((n) => [n.properties.id, n])).values()];
    if (uniq.length > 1) spiderfy(f.geometry.coordinates, uniq);
    else openCard(f.properties.id);
  });

  applyFilter();
  if (!startView && state.filtered.length) fitAll();
  $('loading').hidden = true;

  $('legend').addEventListener('change', (e) => {
    const id = Number(e.target.dataset.type);
    if (e.target.checked) state.visible.add(id);
    else state.visible.delete(id);
    applyFilter();
  });
  $('allTypes').addEventListener('click', () => { state.visible = new Set(state.types.map((t) => t.id)); applyFilter(); });
  $('noTypes').addEventListener('click', () => { state.visible = new Set(); applyFilter(); });
  $('zonesToggle').addEventListener('change', (e) => { state.zones = e.target.checked; updateZones(); writeHash(); });
  $('sourceSelect').addEventListener('change', (e) => { state.source = e.target.value; applyFilter(); });
  $('geomSelect').addEventListener('change', (e) => { state.geom = e.target.value; applyFilter(); });
  $('polygonsToggle').addEventListener('change', (e) => { state.showPolygons = e.target.checked; updatePolygons(); writeHash(); });
  $('attrFilters').addEventListener('change', (e) => {
    state.attrs[Number(e.target.dataset.attr)] = e.target.value;
    applyFilter();
  });
  $('resetFilters').addEventListener('click', resetFilters);
  $('fitAll').addEventListener('click', fitAll);
  $('downloadBtn').addEventListener('click', (e) => downloadSnapshot(map, state, e.currentTarget));
  $('cardClose').addEventListener('click', closeCard);
  $('panelToggle').addEventListener('click', () => document.body.classList.toggle('panel-open'));
  setupSearch();

  if (data.mode !== 'live') {
    setupCsvImport();
    return;
  }
  setupPinsPanel();
  loadSavedPins().catch((e) => toast(`Не удалось загрузить мои метки: ${e.message}`, 'error'));
  // Данные могли обновиться в панели управления — перечитываем при возврате на вкладку.
  let loadedAt = Date.now();
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || Date.now() - loadedAt < 30000) return;
    loadedAt = Date.now();
    try {
      await loadObjects();
      await renderAttrFilters();
      applyFilter();
    } catch (e) {
      fail(e);
    }
  });
}

init().catch((e) => {
  const box = $('loading');
  const reason = typeof maplibregl === 'undefined'
    ? 'не загрузилась библиотека карты — проверьте доступ в интернет'
    : e.message;
  box.hidden = false;
  box.classList.add('loading-error');
  box.textContent = `Не удалось показать карту: ${reason}`;
  fail(e);
});
