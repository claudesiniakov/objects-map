import { can, debounce, esc, fail, fmtDate, fmtNum, logout, modal, toast } from './api.js';
import { csvToObjects, parseCsv, readCsvFile } from './csv.js';
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
  attrNames: [], // поля из настройки filter_attributes
  attrs: [], // выбранное значение по каждому полю: '' — все, NONE — не заполнено
};

let map;
let clusterMarkers = {};
let clustersOnScreen = {};
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
  state.attrNames.forEach((name, i) => { if (state.attrs[i]) p.set(`a.${name}`, state.attrs[i] === NONE ? '-' : state.attrs[i]); });
  history.replaceState(null, '', `#${p.toString().replace(/%2F/g, '/').replace(/%2C/g, ',')}`);
}

// ---------------------------------------------------------------- данные и фильтры

// Фильтры помимо типа: источник и дополнительные поля.
function passesExtra(f) {
  if (state.source && f.properties.s !== state.source) return false;
  for (let i = 0; i < state.attrs.length; i += 1) {
    const want = state.attrs[i];
    if (!want) continue;
    const have = f.properties.a?.[i] ?? null;
    if (want === NONE ? have !== null : have !== want) return false;
  }
  return true;
}

function hasExtraFilters() {
  return Boolean(state.source) || state.attrs.some(Boolean);
}

function applyFilter() {
  state.filtered = state.all.features.filter((f) => state.visible.has(f.properties.t) && passesExtra(f));
  $('resetFilters').hidden = !hasExtraFilters();
  clearClusterMarkers();
  clearSpider();
  map.getSource('objects')?.setData({ type: 'FeatureCollection', features: state.filtered });
  updateZones();
  renderLegend();
  writeHash();
}

async function loadObjects() {
  state.all = await data.objects();
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
    ? 'Объектов нет — нажмите «Импорт CSV» или перетащите CSV-файл в окно'
    : `На карте ${fmtNum(shown)} из ${fmtNum(state.all.features.length)} объектов`;
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
  el.title = `${fmtNum(total)} объектов\n${parts.map((p) => `${p.t.name}: ${fmtNum(p.n)}`).join('\n')}`;
  el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${paths}
    <circle cx="${r}" cy="${r}" r="${r0}" class="cluster-core"/></svg><span>${shortCount(total)}</span>`;
  return el;
}

function clearClusterMarkers() {
  for (const m of Object.values(clustersOnScreen)) m.remove();
  clusterMarkers = {};
  clustersOnScreen = {};
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
      openCard(f.properties.id);
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

async function openCard(id) {
  const card = $('card');
  const body = $('cardBody');
  card.hidden = false;
  body.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    const o = await data.object(id);
    const t = state.typeById.get(o.type_id);
    const icon = t ? await markerDataUrl(t) : '';
    const radius = o.effective_radius_m
      ? `${fmtNum(o.effective_radius_m)} м${o.radius_m ? '' : ' <span class="muted">(по типу)</span>'}`
      : '';
    const attrs = Object.entries(o.attributes || {}).map(([k, v]) => row(k, esc(v))).join('');
    body.innerHTML = `
      <div class="card-head">
        <img src="${icon}" alt="" class="card-icon">
        <div><h2>${esc(o.name)}</h2><div class="muted">${esc(o.type_name)}</div></div>
      </div>
      <table class="kv">
        ${row('ID', esc(o.external_id))}
        ${row('Номер договора', esc(o.contract_number))}
        ${row('Кадастровый номер', o.cadastral_number ? `<span class="mono">${esc(o.cadastral_number)}</span> <button class="link-btn" data-copy="${esc(o.cadastral_number)}">копировать</button>` : '')}
        ${row('Адрес', esc(o.address))}
        ${row('Координаты', `<span class="mono">${o.lat.toFixed(6)}, ${o.lon.toFixed(6)}</span> <button class="link-btn" data-copy="${o.lat}, ${o.lon}">копировать</button>`)}
        ${row('Радиус', radius)}
        ${row('Описание', esc(o.description).replace(/\n/g, '<br>'))}
        ${attrs}
        ${row('Источник', esc(o.source))}
        ${row('Импорт', o.import_file ? `${esc(o.import_file)}, ${fmtDate(o.import_at)}` : '')}
        ${row('Обновлён', fmtDate(o.updated_at))}
      </table>
      <div class="card-actions">
        <button class="btn" data-zoom>Приблизить</button>
        ${data.mode === 'live' && can('operator') ? `<a class="btn" href="/admin#objects/${o.id}">Редактировать</a>` : ''}
      </div>`;
    body.querySelector('[data-zoom]').addEventListener('click', () => {
      map.flyTo({ center: [o.lon, o.lat], zoom: Math.max(map.getZoom(), 16) });
    });
    body.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', (e) => {
      navigator.clipboard?.writeText(e.target.dataset.copy);
      e.target.textContent = 'скопировано';
    }));
  } catch (e) {
    body.innerHTML = `<p class="form-error">${esc(e.message)}</p>`;
  }
}

// ---------------------------------------------------------------- поиск

function setupSearch() {
  const input = $('searchInput');
  const list = $('searchResults');
  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) {
      list.hidden = true;
      return;
    }
    try {
      const items = await data.search(q);
      list.innerHTML = items.length
        ? items.map((o) => `<li><button data-id="${o.id}" data-lon="${o.lon}" data-lat="${o.lat}" data-type="${o.type_id}">
            <b>${esc(o.name)}</b><span class="muted small">${esc(o.type_name)}${o.address ? ` · ${esc(o.address)}` : ''}${o.cadastral_number ? ` · КН ${esc(o.cadastral_number)}` : ''}${o.contract_number ? ` · договор ${esc(o.contract_number)}` : ''}</span></button></li>`).join('')
        : '<li class="muted empty">Ничего не найдено</li>';
      list.hidden = false;
    } catch (e) {
      fail(e);
    }
  }, 250);
  input.addEventListener('input', run);
  input.addEventListener('focus', () => { if (list.children.length && input.value.trim().length >= 2) list.hidden = false; });
  document.addEventListener('click', (e) => { if (!$('search').contains(e.target)) list.hidden = true; });
  list.addEventListener('click', (e) => {
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
    const m = modal('Импорт CSV', `<p>В файле «${esc(fileName)}» объектов: <b>${fmtNum(count)}</b>.
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

function showImportReport(fileName, result, unknownTypes) {
  const { objects, errors } = result;
  const list = errors.slice(0, 200).map((e) => `<li>Строка ${e.row}: ${esc(e.message)}</li>`).join('');
  modal('Импорт завершён', `
    <p>Из «${esc(fileName)}» загружено объектов: <b>${fmtNum(objects.length)}</b>.</p>
    ${unknownTypes.length ? `<p>Типов нет в справочнике, показаны серым: ${unknownTypes.map((t) => `«${esc(t.name)}»`).join(', ')}.</p>` : ''}
    ${errors.length ? `<p>Замечания (${fmtNum(errors.length)}):</p><ul class="import-errors">${list}</ul>
      ${errors.length > 200 ? `<p class="muted small">Показаны первые 200.</p>` : ''}` : ''}`, {
    actions: [{ label: 'Закрыть', kind: 'primary' }],
  });
}

async function importCsv(file) {
  if (!/\.(csv|txt)$/i.test(file.name)) {
    toast('Нужен файл CSV', 'error');
    return;
  }
  try {
    const rows = parseCsv(await readCsvFile(file));
    const result = csvToObjects(rows, data.rawTypes(), data.nextId(), file.name);
    if (!result.objects.length) {
      showImportReport(file.name, result, []);
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
    $('snapshotInfo').textContent = `${$('snapshotInfo').textContent.split(' · ')[0]} · CSV: ${file.name}`;
    const unknown = state.types.filter((t) => t.unknown && result.newTypes.some((n) => n.id === t.id));
    if (result.errors.length || unknown.length) showImportReport(file.name, result, unknown);
    else toast(`Загружено объектов: ${fmtNum(result.objects.length)}`, 'success');
  } catch (e) {
    toast(`Не удалось загрузить CSV: ${e.message}`, 'error', 8000);
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
    const f = e.features[0];
    const t = state.typeById.get(f.properties.t);
    hoverPopup.setLngLat(f.geometry.coordinates).setHTML(`<b>${esc(f.properties.n)}</b><br><span class="muted">${esc(t?.name)}</span>`).addTo(map);
  });
  map.on('mouseleave', 'points', () => {
    map.getCanvas().style.cursor = '';
    hoverPopup.remove();
  });
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
  $('attrFilters').addEventListener('change', (e) => {
    state.attrs[Number(e.target.dataset.attr)] = e.target.value;
    applyFilter();
  });
  $('resetFilters').addEventListener('click', resetFilters);
  $('fitAll').addEventListener('click', fitAll);
  $('downloadBtn').addEventListener('click', (e) => downloadSnapshot(map, state, e.currentTarget));
  $('cardClose').addEventListener('click', () => { $('card').hidden = true; });
  $('panelToggle').addEventListener('click', () => document.body.classList.toggle('panel-open'));
  setupSearch();

  if (data.mode !== 'live') {
    setupCsvImport();
    return;
  }
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
