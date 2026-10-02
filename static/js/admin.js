import {
  ROLE_NAME, api, can, confirmDialog, debounce, download, ensureLogin, esc, fail, fmtDate, fmtNum, logout, modal,
  request, toast,
} from './api.js';
import { ICON_NAMES, glyphSvg, markerCanvas, markerDataUrl } from './icons.js';

const view = document.getElementById('view');
let types = [];
let typeById = new Map();

const OSM_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© участники OpenStreetMap',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

let settingsCache = null;
async function settings() {
  settingsCache ??= await api.get('/api/settings');
  return settingsCache;
}

async function loadTypes() {
  types = await api.get('/api/types');
  typeById = new Map(types.map((t) => [t.id, t]));
}

function typeOptions(selected, { empty = '' } = {}) {
  return (empty ? `<option value="">${esc(empty)}</option>` : '')
    + types.map((t) => `<option value="${t.id}" ${Number(selected) === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
}

async function miniMap(container, { center, zoom } = {}) {
  const s = await settings();
  const map = new maplibregl.Map({
    container,
    style: OSM_STYLE,
    center: center ?? [s.center_lon, s.center_lat],
    zoom: zoom ?? s.zoom,
    dragRotate: false,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  await new Promise((r) => map.on('load', r));
  return map;
}

async function addTypeImages(map) {
  await Promise.all(types.map(async (t) => {
    const c = await markerCanvas(t);
    if (!map.hasImage(`type-${t.id}`)) {
      map.addImage(`type-${t.id}`, c.getContext('2d').getImageData(0, 0, c.width, c.height), { pixelRatio: 2 });
    }
  }));
}

function pager(total, page, pageSize, onPage) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const el = document.createElement('div');
  el.className = 'pager';
  el.innerHTML = `
    <button class="btn small" data-p="${page - 1}" ${page <= 1 ? 'disabled' : ''}>←</button>
    <span>Стр. ${page} из ${pages} · всего ${fmtNum(total)}</span>
    <button class="btn small" data-p="${page + 1}" ${page >= pages ? 'disabled' : ''}>→</button>`;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]');
    if (b && !b.disabled) onPage(Number(b.dataset.p));
  });
  return el;
}

// ================================================================ ИМПОРТ

const MODE_TEXT = {
  add: 'Добавить — все строки станут новыми объектами',
  upsert: 'Обновить / добавить — по ID: существующие обновятся, новые добавятся',
  replace: 'Заменить — объекты прошлых импортов из этого источника удалятся и загрузятся заново',
};
const MODE_SHORT = { add: 'Добавить', upsert: 'Обновить / добавить', replace: 'Заменить' };
const STATUS_TEXT = { committed: 'Выполнен', rolled_back: 'Откачен' };
const ACTION_TEXT = { create: 'новый', update: 'обновление', skip: 'пропуск' };

async function renderImport() {
  view.innerHTML = `
    <section class="panel">
      <div class="panel-head">
        <h2>Импорт из Excel</h2>
        <button class="btn" id="tplBtn">Скачать шаблон</button>
      </div>
      <label class="dropzone" id="dropzone">
        <input type="file" id="fileInput" accept=".xlsx,.xls,.xlsm,.csv" hidden>
        <strong>Перетащите файл сюда</strong> или нажмите, чтобы выбрать
        <span class="muted small">.xlsx, .xls, .csv — до 20 МБ и 100 000 строк</span>
      </label>
      <div id="importWork"></div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>История импортов</h2></div>
      <div id="history" class="table-wrap"><p class="muted">Загрузка…</p></div>
    </section>`;
  document.getElementById('tplBtn').addEventListener('click', () => download('/api/import/template', 'shablon.xlsx').catch(fail));
  const dz = document.getElementById('dropzone');
  const input = document.getElementById('fileInput');
  input.addEventListener('change', () => input.files[0] && uploadFile(input.files[0]));
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
  });
  renderHistory();
}

async function renderHistory() {
  const box = document.getElementById('history');
  if (!box) return;
  try {
    const items = await api.get('/api/import');
    if (!items.length) {
      box.innerHTML = '<p class="muted">Импортов пока не было.</p>';
      return;
    }
    box.innerHTML = `<table class="table">
      <thead><tr><th>Дата</th><th>Автор</th><th>Файл</th><th>Источник</th><th>Режим</th>
        <th class="num">Добавлено</th><th class="num">Обновлено</th><th class="num">Удалено</th><th class="num">Ошибок</th><th>Статус</th><th></th></tr></thead>
      <tbody>${items.map((b) => `<tr>
        <td>${fmtDate(b.committed_at)}</td><td>${esc(b.user_login)}</td>
        <td><button class="link-btn" data-file="${b.id}" data-name="${esc(b.file_name)}">${esc(b.file_name)}</button></td>
        <td>${esc(b.source)}</td><td>${esc(MODE_SHORT[b.mode] || b.mode)}</td>
        <td class="num">${fmtNum(b.added)}</td><td class="num">${fmtNum(b.updated)}</td><td class="num">${fmtNum(b.deleted)}</td>
        <td class="num">${b.errors ? `<button class="link-btn" data-errors="${b.id}">${fmtNum(b.errors)}</button>` : '0'}</td>
        <td><span class="badge ${b.status}">${STATUS_TEXT[b.status] || b.status}${b.rolled_back_at ? ` ${fmtDate(b.rolled_back_at)}` : ''}</span></td>
        <td>${b.can_rollback ? `<button class="btn small danger" data-rollback="${b.id}">Откатить</button>` : ''}</td>
      </tr>`).join('')}</tbody></table>`;
    box.onclick = async (e) => {
      const t = e.target;
      try {
        if (t.dataset.file) await download(`/api/import/${t.dataset.file}/file`, t.dataset.name);
        if (t.dataset.errors) await download(`/api/import/${t.dataset.errors}/errors`, 'errors.xlsx');
        if (t.dataset.rollback) {
          const b = items.find((i) => i.id === Number(t.dataset.rollback));
          const ok = await confirmDialog('Откатить импорт?',
            `Импорт «${b.file_name}» будет отменён: добавленные им объекты (${b.added}) удалятся, обновлённые (${b.updated}) и удалённые (${b.deleted}) вернутся к прежнему состоянию.`,
            'Откатить');
          if (!ok) return;
          const res = await api.post(`/api/import/${b.id}/rollback`);
          toast(`Импорт откачен: удалено ${res.removed}, восстановлено ${res.restored}`, 'success');
          renderHistory();
        }
      } catch (ex) {
        fail(ex);
      }
    };
  } catch (e) {
    box.innerHTML = `<p class="form-error">${esc(e.message)}</p>`;
  }
}

async function uploadFile(file) {
  const work = document.getElementById('importWork');
  work.innerHTML = `<p class="muted">Загрузка «${esc(file.name)}»…</p>`;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const up = await request('POST', '/api/import', fd);
    const mappings = await api.get('/api/import/mappings');
    renderMappingStep(up, mappings);
  } catch (e) {
    work.innerHTML = `<p class="form-error">${esc(e.message)}</p>`;
  }
}

function renderMappingStep(up, mappings) {
  const work = document.getElementById('importWork');
  const sheets = up.sheets.filter((s) => s.rows > 0);
  let sheet = sheets[0];
  const fieldOptions = (value) => [
    ...Object.entries(up.fields).map(([k, label]) => `<option value="${k}" ${value === k ? 'selected' : ''}>${esc(label)}${up.required.includes(k) ? ' *' : ''}</option>`),
    `<option value="attr" ${value === 'attr' ? 'selected' : ''}>Доп. поле</option>`,
    `<option value="ignore" ${value === 'ignore' ? 'selected' : ''}>Не загружать</option>`,
  ].join('');

  const draw = (mapping) => {
    work.innerHTML = `
      <div class="import-step">
        <h3>1. Настройка: ${esc(up.file_name)}</h3>
        <div class="form-grid">
          <label>Лист
            <select id="sheetSel">${sheets.map((s) => `<option ${s === sheet ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
            <span class="muted small">${fmtNum(sheet.rows)} строк</span>
          </label>
          <label>Источник
            <input id="sourceInp" value="${esc(up.source)}" maxlength="255">
            <span class="muted small">По источнику работает режим «Заменить» и фильтр на карте</span>
          </label>
          <label>Шаблон сопоставления
            <select id="mapTpl"><option value="">— автоматически по заголовкам —</option>
              ${mappings.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>
          </label>
        </div>
        <fieldset class="modes">
          <legend>Режим</legend>
          ${Object.entries(MODE_TEXT).map(([k, txt]) => `<label class="check"><input type="radio" name="mode" value="${k}" ${k === 'upsert' ? 'checked' : ''}> ${esc(txt)}</label>`).join('')}
        </fieldset>
        <div class="table-wrap">
          <table class="table mapping">
            <thead><tr><th>Колонка файла</th><th>Примеры значений</th><th>Поле объекта</th></tr></thead>
            <tbody>${sheet.headers.map((h, i) => `<tr>
              <td><b>${esc(h)}</b></td>
              <td class="muted small">${sheet.sample.map((r) => esc(r[i] ?? '')).filter(Boolean).slice(0, 3).join(' · ')}</td>
              <td><select data-col="${esc(h)}">${fieldOptions(mapping[h] || 'attr')}</select></td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="actions-row">
          <button class="btn primary" id="checkBtn">Проверить</button>
          <button class="btn" id="saveTpl">Сохранить сопоставление как шаблон</button>
        </div>
      </div>
      <div id="previewBox"></div>`;
    const readMapping = () => Object.fromEntries([...work.querySelectorAll('select[data-col]')].map((s) => [s.dataset.col, s.value]));
    work.querySelector('#sheetSel').addEventListener('change', (e) => {
      sheet = sheets.find((s) => s.name === e.target.value);
      draw(sheet.suggested_mapping);
    });
    work.querySelector('#mapTpl').addEventListener('change', (e) => {
      const m = mappings.find((x) => x.id === Number(e.target.value));
      const base = { ...sheet.suggested_mapping };
      if (m) for (const h of sheet.headers) if (m.mapping[h]) base[h] = m.mapping[h];
      const keep = e.target.value;
      draw(base);
      work.querySelector('#mapTpl').value = keep;
    });
    work.querySelector('#saveTpl').addEventListener('click', () => {
      const dlg = modal('Сохранить шаблон', '<label>Название<input id="tplName" maxlength="100"></label>', {
        actions: [{ label: 'Отмена' }, {
          label: 'Сохранить',
          kind: 'primary',
          onClick: async (w) => {
            const name = w.querySelector('#tplName').value.trim();
            if (!name) return false;
            await api.post('/api/import/mappings', { name, mapping: readMapping() });
            mappings.splice(0, mappings.length, ...(await api.get('/api/import/mappings')));
            toast('Шаблон сохранён', 'success');
            return true;
          },
        }],
      });
      dlg.querySelector('#tplName').focus();
    });
    work.querySelector('#checkBtn').addEventListener('click', async (e) => {
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = 'Проверка…';
      const body = {
        sheet: sheet.name,
        mapping: readMapping(),
        mode: work.querySelector('input[name=mode]:checked').value,
        source: work.querySelector('#sourceInp').value.trim() || up.source,
      };
      try {
        const pv = await api.post(`/api/import/${up.id}/preview`, body);
        renderPreview(up, body, pv, () => btn.click());
      } catch (ex) {
        document.getElementById('previewBox').innerHTML = `<p class="form-error">${esc(ex.message)}</p>`;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Проверить';
      }
    });
  };
  draw(sheet.suggested_mapping);
}

function previewRows(rows) {
  if (!rows.length) return '<p class="muted">Нет строк.</p>';
  return `<table class="table">
    <thead><tr><th class="num">Строка</th><th>Действие</th><th>ID</th><th>Тип</th><th>Название</th><th>Координаты</th><th class="num">Радиус</th><th>Замечания</th></tr></thead>
    <tbody>${rows.map((r) => `<tr class="${r.errors.length ? 'row-error' : r.warnings.length ? 'row-warn' : ''}">
      <td class="num">${r.row}</td><td>${ACTION_TEXT[r.action]}</td><td>${esc(r.external_id)}</td><td>${esc(r.type_name)}</td>
      <td>${esc(r.name)}</td><td class="mono small">${r.lat ?? '—'}, ${r.lon ?? '—'}</td><td class="num">${r.radius_m ?? ''}</td>
      <td>${[...r.errors.map((m) => `<div class="err">${esc(m)}</div>`), ...r.warnings.map((m) => `<div class="warn">${esc(m)}</div>`)].join('')}</td>
    </tr>`).join('')}</tbody></table>`;
}

async function renderPreview(up, body, pv, recheck) {
  const box = document.getElementById('previewBox');
  const c = pv.counts;
  const willWrite = c.create + c.update + c.delete;
  box.innerHTML = `
    <div class="import-step">
      <h3>2. Предпросмотр</h3>
      <div class="stats-row">
        <div class="stat"><b>${fmtNum(c.total)}</b><span>строк в файле</span></div>
        <div class="stat good"><b>${fmtNum(c.create)}</b><span>будет добавлено</span></div>
        <div class="stat info"><b>${fmtNum(c.update)}</b><span>будет обновлено</span></div>
        ${body.mode === 'replace' ? `<div class="stat warn"><b>${fmtNum(c.delete)}</b><span>будет удалено (старые из «${esc(body.source)}»)</span></div>` : ''}
        <div class="stat bad"><b>${fmtNum(c.skip)}</b><span>пропущено с ошибками</span></div>
        <div class="stat warn"><b>${fmtNum(c.warnings)}</b><span>с предупреждениями</span></div>
      </div>
      ${pv.unknown_types.length ? `<div class="notice">
        <b>Неизвестные типы:</b>
        ${pv.unknown_types.map((u) => `<span class="chip">${esc(u.name)} — ${fmtNum(u.rows)} стр.
          ${can('admin') ? `<button class="link-btn" data-newtype="${esc(u.name)}">создать тип</button>` : ''}</span>`).join(' ')}
        ${can('admin') ? '' : '<span class="muted small">Попросите администратора добавить их в справочник.</span>'}
      </div>` : ''}
      <div class="preview-grid">
        <div class="minimap" id="pvMap"></div>
        <div>
          <div class="subtabs">
            <button class="subtab active" data-st="problems">Ошибки и предупреждения (${fmtNum(pv.problems_total)})</button>
            <button class="subtab" data-st="rows">Первые ${pv.rows.length} строк</button>
          </div>
          <div class="table-wrap tall" id="pvTable">${previewRows(pv.problems)}</div>
          ${pv.problems_total > pv.problems.length ? `<p class="muted small">Показаны первые ${pv.problems.length}; полный список — в отчёте.</p>` : ''}
        </div>
      </div>
      <div class="actions-row">
        <button class="btn primary" id="commitBtn" ${willWrite ? '' : 'disabled'}>Загрузить в базу (${fmtNum(c.create + c.update)} строк)</button>
        ${pv.problems_total ? '<button class="btn" id="errBtn">Скачать отчёт об ошибках</button>' : ''}
      </div>
    </div>`;

  box.querySelectorAll('.subtab').forEach((b) => b.addEventListener('click', () => {
    box.querySelectorAll('.subtab').forEach((x) => x.classList.toggle('active', x === b));
    box.querySelector('#pvTable').innerHTML = previewRows(b.dataset.st === 'rows' ? pv.rows : pv.problems);
  }));
  box.querySelector('#errBtn')?.addEventListener('click', () => download(`/api/import/${up.id}/errors`, 'errors.xlsx').catch(fail));
  box.querySelectorAll('[data-newtype]').forEach((b) => b.addEventListener('click', () => {
    editType({ code: '', name: b.dataset.newtype }, async () => {
      await loadTypes();
      recheck();
    });
  }));
  box.querySelector('#commitBtn').addEventListener('click', async (e) => {
    if (body.mode === 'replace' && c.delete) {
      const ok = await confirmDialog('Заменить объекты источника?',
        `Будут удалены ${c.delete} объектов источника «${body.source}» и загружены ${c.create} новых.`, 'Заменить');
      if (!ok) return;
    }
    e.target.disabled = true;
    e.target.textContent = 'Запись…';
    try {
      const res = await api.post(`/api/import/${up.id}/commit`);
      toast(`Готово: добавлено ${res.added}, обновлено ${res.updated}, удалено ${res.deleted}, пропущено ${res.errors}`, 'success', 8000);
      document.getElementById('importWork').innerHTML = `
        <div class="notice success">Импорт «${esc(up.file_name)}» выполнен: добавлено ${fmtNum(res.added)}, обновлено ${fmtNum(res.updated)},
        удалено ${fmtNum(res.deleted)}, пропущено ${fmtNum(res.errors)}. <a href="/">Открыть карту</a></div>`;
      renderHistory();
    } catch (ex) {
      fail(ex);
      e.target.disabled = false;
      e.target.textContent = 'Загрузить в базу';
    }
  });

  try {
    const map = await miniMap('pvMap');
    await addTypeImages(map);
    const features = pv.points.map(([lon, lat, t]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { t } }));
    map.addSource('pv', { type: 'geojson', data: { type: 'FeatureCollection', features } });
    map.addLayer({
      id: 'pv', type: 'circle', source: 'pv',
      paint: {
        'circle-radius': 4,
        'circle-color': ['match', ['get', 't'], ...types.flatMap((t) => [t.id, t.color]), '#888'],
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 1,
      },
    });
    if (features.length) {
      const b = new maplibregl.LngLatBounds();
      features.forEach((f) => b.extend(f.geometry.coordinates));
      map.fitBounds(b, { padding: 30, maxZoom: 14, duration: 0 });
    }
  } catch (e) {
    console.warn(e);
  }
}

// ================================================================ ОБЪЕКТЫ

const objState = { q: '', type_id: '', source: '', attrs: {}, sort: 'id', order: 'desc', page: 1, selected: new Set() };
const ATTR_NONE = '__none__'; // значение фильтра «не заполнено»

// Фильтры по дополнительным полям → параметр attrs={"поле": "значение" | null}.
function attrsParam(p) {
  const active = Object.entries(objState.attrs).filter(([, v]) => v);
  if (active.length) p.set('attrs', JSON.stringify(Object.fromEntries(active.map(([k, v]) => [k, v === ATTR_NONE ? null : v]))));
}

async function renderObjects(editId) {
  settingsCache = null;
  const [sources, s] = await Promise.all([api.get('/api/sources'), settings()]);
  const attrNames = s.filter_attributes || [];
  const attrValues = await Promise.all(attrNames.map((n) => api.get(`/api/attribute-values?name=${encodeURIComponent(n)}`)));
  for (const k of Object.keys(objState.attrs)) if (!attrNames.includes(k)) delete objState.attrs[k];
  view.innerHTML = `
    <section class="panel">
      <div class="panel-head">
        <h2>Объекты</h2>
        <div class="actions-row">
          <button class="btn primary" id="addObj">Добавить объект</button>
          <button class="btn" id="exportBtn">Экспорт в Excel</button>
        </div>
      </div>
      <div class="filters">
        <input type="search" id="fQ" placeholder="Поиск: название, адрес, ID, договор, кадастровый №" value="${esc(objState.q)}">
        <select id="fType">${typeOptions(objState.type_id, { empty: 'Все типы' })}</select>
        <select id="fSource"><option value="">Все источники</option>
          ${sources.map((src) => `<option value="${esc(src.source)}" ${src.source === objState.source ? 'selected' : ''}>${esc(src.source)} (${fmtNum(src.objects)})</option>`).join('')}</select>
        ${attrNames.map((name, i) => `<select data-attr="${esc(name)}" title="${esc(name)}">
          <option value="">${esc(name)}: все</option>
          ${attrValues[i].filter((v) => v.value !== null).map((v) => `<option value="${esc(v.value)}">${esc(v.value)} (${fmtNum(v.objects)})</option>`).join('')}
          ${attrValues[i].some((v) => v.value === null) ? `<option value="${ATTR_NONE}">${esc(name)}: не заполнено (${fmtNum(attrValues[i].find((v) => v.value === null).objects)})</option>` : ''}
        </select>`).join('')}
      </div>
      <div class="bulkbar" id="bulkbar" hidden>
        <span id="selCount"></span>
        <select id="bulkType">${typeOptions('', { empty: 'Сменить тип на…' })}</select>
        <button class="btn small" id="bulkTypeBtn">Применить</button>
        <button class="btn small danger" id="bulkDel">Удалить выбранные</button>
        <button class="link-btn" id="bulkClear">снять выделение</button>
      </div>
      <div class="table-wrap" id="objTable"><p class="muted">Загрузка…</p></div>
      <div id="objPager"></div>
    </section>`;
  const reload = () => { objState.page = 1; loadObjectsTable(); };
  document.getElementById('fQ').addEventListener('input', debounce((e) => { objState.q = e.target.value; reload(); }, 300));
  document.getElementById('fType').addEventListener('change', (e) => { objState.type_id = e.target.value; reload(); });
  document.getElementById('fSource').addEventListener('change', (e) => { objState.source = e.target.value; reload(); });
  view.querySelectorAll('select[data-attr]').forEach((sel) => {
    sel.value = objState.attrs[sel.dataset.attr] || '';
    sel.addEventListener('change', () => { objState.attrs[sel.dataset.attr] = sel.value; reload(); });
  });
  document.getElementById('addObj').addEventListener('click', () => editObject(null));
  document.getElementById('exportBtn').addEventListener('click', () => {
    const p = new URLSearchParams();
    if (objState.q) p.set('q', objState.q);
    if (objState.type_id) p.set('type_id', objState.type_id);
    if (objState.source) p.set('source', objState.source);
    attrsParam(p);
    download(`/api/export?${p}`, 'objects.xlsx').catch(fail);
  });
  document.getElementById('bulkClear').addEventListener('click', () => { objState.selected.clear(); loadObjectsTable(); });
  document.getElementById('bulkDel').addEventListener('click', async () => {
    const ids = [...objState.selected];
    if (!(await confirmDialog('Удалить объекты?', `Будет удалено объектов: ${ids.length}. Действие попадёт в журнал.`, 'Удалить'))) return;
    try {
      const r = await api.post('/api/objects/bulk-delete', { ids });
      toast(`Удалено: ${r.deleted}`, 'success');
      objState.selected.clear();
      loadObjectsTable();
    } catch (e) { fail(e); }
  });
  document.getElementById('bulkTypeBtn').addEventListener('click', async () => {
    const typeId = Number(document.getElementById('bulkType').value);
    if (!typeId) return toast('Выберите тип', 'error');
    try {
      const r = await api.post('/api/objects/bulk-type', { ids: [...objState.selected], type_id: typeId });
      toast(`Тип изменён у ${r.updated} объектов`, 'success');
      objState.selected.clear();
      loadObjectsTable();
    } catch (e) { fail(e); }
  });
  await loadObjectsTable();
  if (editId) editObject(Number(editId));
}

const OBJ_COLUMNS = [
  ['external_id', 'ID'], ['contract_number', 'Договор'], ['cadastral_number', 'Кадастровый №'], ['name', 'Название'], ['type', 'Тип'], [null, 'Адрес'], [null, 'Координаты'],
  ['radius_m', 'Радиус, м'], ['source', 'Источник'], ['updated_at', 'Обновлён'],
];

let objRequestSeq = 0;

async function loadObjectsTable() {
  const box = document.getElementById('objTable');
  if (!box) return;
  // Ответы могут прийти не по порядку — рисуем только ответ на последний запрос.
  const seq = ++objRequestSeq;
  const p = new URLSearchParams({ sort: objState.sort, order: objState.order, page: objState.page, page_size: 50 });
  if (objState.q) p.set('q', objState.q);
  if (objState.type_id) p.set('type_id', objState.type_id);
  if (objState.source) p.set('source', objState.source);
  attrsParam(p);
  try {
    const { total, items } = await api.get(`/api/admin/objects?${p}`);
    const icons = await Promise.all(items.map((o) => (typeById.get(o.type_id) ? markerDataUrl(typeById.get(o.type_id)) : '')));
    if (seq !== objRequestSeq) return;
    box.innerHTML = items.length ? `<table class="table hover">
      <thead><tr><th><input type="checkbox" id="selAll" aria-label="Выбрать все на странице"></th>
        ${OBJ_COLUMNS.map(([k, label]) => (k
          ? `<th><button class="sort ${objState.sort === k ? objState.order : ''}" data-sort="${k}">${label}</button></th>`
          : `<th>${label}</th>`)).join('')}</tr></thead>
      <tbody>${items.map((o, i) => `<tr data-id="${o.id}">
        <td><input type="checkbox" data-sel="${o.id}" ${objState.selected.has(o.id) ? 'checked' : ''}></td>
        <td>${esc(o.external_id)}</td><td>${esc(o.contract_number)}</td><td class="mono small nowrap">${esc(o.cadastral_number)}</td><td><b>${esc(o.name)}</b></td>
        <td class="nowrap"><img src="${icons[i]}" class="tiny-icon" alt=""> ${esc(o.type_name)}</td>
        <td>${esc(o.address)}</td><td class="mono small nowrap">${o.lat.toFixed(5)}, ${o.lon.toFixed(5)}</td>
        <td class="num">${o.effective_radius_m ? fmtNum(o.effective_radius_m) : ''}${o.effective_radius_m && !o.radius_m ? '<span class="muted">*</span>' : ''}</td>
        <td>${esc(o.source)}</td><td class="nowrap">${fmtDate(o.updated_at)}</td>
      </tr>`).join('')}</tbody></table>
      <p class="muted small">* радиус по умолчанию из типа</p>`
      : '<p class="muted">Объектов не найдено.</p>';
    const pg = document.getElementById('objPager');
    pg.innerHTML = '';
    pg.append(pager(total, objState.page, 50, (n) => { objState.page = n; loadObjectsTable(); }));
    box.onclick = (e) => {
      const sortBtn = e.target.closest('[data-sort]');
      if (sortBtn) {
        const k = sortBtn.dataset.sort;
        objState.order = objState.sort === k && objState.order === 'asc' ? 'desc' : 'asc';
        objState.sort = k;
        loadObjectsTable();
        return;
      }
      if (e.target.matches('input[type=checkbox]')) return;
      const tr = e.target.closest('tr[data-id]');
      if (tr) editObject(Number(tr.dataset.id));
    };
    box.onchange = (e) => {
      if (e.target.id === 'selAll') {
        box.querySelectorAll('[data-sel]').forEach((cb) => {
          cb.checked = e.target.checked;
          if (cb.checked) objState.selected.add(Number(cb.dataset.sel));
          else objState.selected.delete(Number(cb.dataset.sel));
        });
      } else if (e.target.dataset.sel) {
        const id = Number(e.target.dataset.sel);
        if (e.target.checked) objState.selected.add(id);
        else objState.selected.delete(id);
      }
      updateBulkbar();
    };
    updateBulkbar();
  } catch (e) {
    box.innerHTML = `<p class="form-error">${esc(e.message)}</p>`;
  }
}

function updateBulkbar() {
  const bar = document.getElementById('bulkbar');
  bar.hidden = objState.selected.size === 0;
  document.getElementById('selCount').textContent = `Выбрано: ${objState.selected.size}`;
}

function attrsToText(attrs) {
  return Object.entries(attrs || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
}

function textToAttrs(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (k) out[k] = line.slice(i + 1).trim();
  }
  return out;
}

async function editObject(id) {
  let o = { type_id: types[0]?.id, name: '', lat: null, lon: null, attributes: {} };
  if (id) {
    try { o = await api.get(`/api/objects/${id}`); } catch (e) { return fail(e); }
  }
  const dlg = modal(id ? `Объект: ${o.name}` : 'Новый объект', `
    <form class="object-form" id="objForm">
      <div class="form-grid">
        <label>Название *<input name="name" value="${esc(o.name)}" required></label>
        <label>Тип *<select name="type_id">${typeOptions(o.type_id)}</select></label>
        <label>ID (внешний)<input name="external_id" value="${esc(o.external_id)}"></label>
        <label>Номер договора<input name="contract_number" value="${esc(o.contract_number)}" maxlength="100"></label>
        <label>Кадастровый номер<input name="cadastral_number" value="${esc(o.cadastral_number)}" maxlength="100" placeholder="77:01:0001001:1234"></label>
        <label>Источник<input name="source" value="${esc(o.source)}"></label>
        <label>Широта *<input name="lat" value="${o.lat ?? ''}" inputmode="decimal" required></label>
        <label>Долгота *<input name="lon" value="${o.lon ?? ''}" inputmode="decimal" required></label>
        <label>Радиус, м<input name="radius_m" value="${o.radius_m ?? ''}" inputmode="numeric" placeholder="по типу"></label>
        <label>Адрес<input name="address" value="${esc(o.address)}"></label>
      </div>
      <p class="muted small">Щёлкните по карте, чтобы поставить точку, или перетащите маркер.</p>
      <div class="minimap" id="objMap"></div>
      <label>Описание<textarea name="description" rows="2">${esc(o.description)}</textarea></label>
      <label>Дополнительные поля <span class="muted small">(по одному на строку: «Поле: значение»)</span>
        <textarea name="attributes" rows="3">${esc(attrsToText(o.attributes))}</textarea></label>
    </form>`, {
    wide: true,
    actions: [
      ...(id ? [{
        label: 'Удалить',
        kind: 'danger left',
        onClick: async () => {
          if (!(await confirmDialog('Удалить объект?', `«${o.name}» будет удалён.`, 'Удалить'))) return false;
          await api.del(`/api/objects/${id}`);
          toast('Объект удалён', 'success');
          loadObjectsTable();
          return true;
        },
      }] : []),
      { label: 'Отмена' },
      {
        label: 'Сохранить',
        kind: 'primary',
        onClick: async (w) => {
          const f = w.querySelector('#objForm');
          if (!f.reportValidity()) return false;
          const fd = new FormData(f);
          const num = (v) => (String(v).trim() === '' ? null : Number(String(v).replace(',', '.')));
          const body = {
            name: fd.get('name'), type_id: Number(fd.get('type_id')), external_id: fd.get('external_id'),
            contract_number: fd.get('contract_number'), cadastral_number: fd.get('cadastral_number'),
            source: fd.get('source'), lat: num(fd.get('lat')), lon: num(fd.get('lon')), radius_m: num(fd.get('radius_m')),
            address: fd.get('address'), description: fd.get('description'), attributes: textToAttrs(fd.get('attributes')),
          };
          if (body.lat === null || body.lon === null || Number.isNaN(body.lat) || Number.isNaN(body.lon)) {
            toast('Укажите координаты числами', 'error');
            return false;
          }
          if (id) await api.put(`/api/objects/${id}`, body);
          else await api.post('/api/objects', body);
          toast('Сохранено', 'success');
          loadObjectsTable();
          return true;
        },
      },
    ],
  });
  if (history.replaceState && id) history.replaceState(null, '', '#objects');

  const form = dlg.querySelector('#objForm');
  const has = o.lat != null;
  const map = await miniMap(dlg.querySelector('#objMap'), has ? { center: [o.lon, o.lat], zoom: 15 } : {});
  const typeOf = () => typeById.get(Number(form.type_id.value));
  const el = document.createElement('img');
  el.className = 'drag-marker';
  const setIcon = async () => { if (typeOf()) el.src = await markerDataUrl(typeOf()); };
  setIcon();
  const marker = new maplibregl.Marker({ element: el, anchor: 'bottom', draggable: true });
  const place = (lng, lat) => {
    marker.setLngLat([lng, lat]).addTo(map);
    form.lat.value = lat.toFixed(6);
    form.lon.value = lng.toFixed(6);
  };
  if (has) marker.setLngLat([o.lon, o.lat]).addTo(map);
  map.on('click', (e) => place(e.lngLat.lng, e.lngLat.lat));
  marker.on('dragend', () => { const p = marker.getLngLat(); place(p.lng, p.lat); });
  form.type_id.addEventListener('change', setIcon);
  const sync = () => {
    const lat = Number(form.lat.value.replace(',', '.'));
    const lon = Number(form.lon.value.replace(',', '.'));
    if (Number.isFinite(lat) && Number.isFinite(lon) && form.lat.value && form.lon.value && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      marker.setLngLat([lon, lat]).addTo(map);
      map.easeTo({ center: [lon, lat] });
    }
  };
  form.lat.addEventListener('change', sync);
  form.lon.addEventListener('change', sync);
}

// ================================================================ ТИПЫ

async function renderTypes() {
  await loadTypes();
  const admin = can('admin');
  const icons = await Promise.all(types.map(markerDataUrl));
  view.innerHTML = `
    <section class="panel">
      <div class="panel-head">
        <h2>Типы объектов</h2>
        ${admin ? '<button class="btn primary" id="addType">Добавить тип</button>' : '<span class="muted">Изменять справочник может администратор</span>'}
      </div>
      <div class="table-wrap"><table class="table ${admin ? 'hover' : ''}">
        <thead><tr><th></th><th>Название</th><th>Код</th><th>Цвет</th><th>Зона</th><th class="num">Прозрачность</th>
          <th class="num">Порядок</th><th>На карте сразу</th><th class="num">Объектов</th>${admin ? '<th></th>' : ''}</tr></thead>
        <tbody>${types.map((t, i) => `<tr data-id="${t.id}">
          <td><img src="${icons[i]}" class="tiny-icon" alt=""></td><td><b>${esc(t.name)}</b></td><td class="mono">${esc(t.code)}</td>
          <td><span class="swatch" style="background:${esc(t.color)}"></span> <span class="mono small">${esc(t.color)}</span></td>
          <td>${t.has_radius ? `${fmtNum(t.default_radius_m)} м` : '—'}</td>
          <td class="num">${Math.round(t.fill_opacity * 100)}%</td><td class="num">${t.sort_order}</td>
          <td>${t.visible_default ? 'да' : 'нет'}</td><td class="num">${fmtNum(t.objects)}</td>
          ${admin ? `<td><button class="btn small danger" data-del="${t.id}" ${t.objects ? 'disabled title="Есть объекты этого типа"' : ''}>Удалить</button></td>` : ''}
        </tr>`).join('')}</tbody>
      </table></div>
    </section>`;
  if (!admin) return;
  document.getElementById('addType').addEventListener('click', () => editType(null, renderTypes));
  view.querySelector('tbody').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      const t = typeById.get(Number(del.dataset.del));
      if (!(await confirmDialog('Удалить тип?', `Тип «${t.name}» будет удалён.`, 'Удалить'))) return;
      try {
        await api.del(`/api/types/${t.id}`);
        toast('Тип удалён', 'success');
        renderTypes();
      } catch (ex) { fail(ex); }
      return;
    }
    const tr = e.target.closest('tr[data-id]');
    if (tr) editType(typeById.get(Number(tr.dataset.id)), renderTypes);
  });
}

async function editType(t, onSaved) {
  const isNew = !t || !t.id;
  const v = {
    code: '', name: '', icon: 'circle', color: '#1e88e5', has_radius: false, default_radius_m: 500,
    fill_opacity: 0.2, sort_order: (types.at(-1)?.sort_order ?? 0) + 1, visible_default: true, ...(t || {}),
  };
  if (isNew && !v.code && v.name) v.code = v.name.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '_').slice(0, 50);
  const iconsList = await api.get('/api/icons');
  const allIcons = [...iconsList.builtin, ...iconsList.uploaded];
  const dlg = modal(isNew ? 'Новый тип' : `Тип: ${v.name}`, `
    <form id="typeForm" class="type-form">
      <div class="form-grid">
        <label>Название *<input name="name" value="${esc(v.name)}" required maxlength="255"></label>
        <label>Код * <span class="muted small">(как в Excel)</span><input name="code" value="${esc(v.code)}" required maxlength="50"></label>
        <label>Цвет<input name="color" type="color" value="${esc(v.color)}"></label>
        <label>Порядок в легенде<input name="sort_order" type="number" value="${v.sort_order}"></label>
      </div>
      <div class="icon-picker" id="iconPicker">
        ${allIcons.map((ic) => `<button type="button" class="icon-choice ${ic === v.icon ? 'active' : ''}" data-icon="${esc(ic)}" title="${esc(ICON_NAMES[ic] || ic.slice(7))}">${glyphSvg(ic, '#333', 22)}</button>`).join('')}
        <label class="icon-choice upload" title="Загрузить SVG или PNG">＋<input type="file" accept=".svg,.png" hidden id="iconUpload"></label>
      </div>
      <div class="form-grid">
        <label class="check"><input type="checkbox" name="has_radius" ${v.has_radius ? 'checked' : ''}> Есть зона (радиус)</label>
        <label>Радиус по умолчанию, м<input name="default_radius_m" type="number" min="1" max="100000" value="${v.default_radius_m ?? ''}"></label>
        <label>Прозрачность заливки: <output id="opOut">${Math.round(v.fill_opacity * 100)}%</output>
          <input name="fill_opacity" type="range" min="0.05" max="0.8" step="0.05" value="${v.fill_opacity}"></label>
        <label class="check"><input type="checkbox" name="visible_default" ${v.visible_default ? 'checked' : ''}> Показывать на карте по умолчанию</label>
      </div>
      <div class="type-preview"><span class="muted small">Предпросмотр</span><canvas id="typePrev" width="320" height="160"></canvas></div>
    </form>`, {
    wide: true,
    actions: [{ label: 'Отмена' }, {
      label: 'Сохранить',
      kind: 'primary',
      onClick: async (w) => {
        const f = w.querySelector('#typeForm');
        if (!f.reportValidity()) return false;
        const body = readType(f);
        if (isNew) await api.post('/api/types', body);
        else await api.put(`/api/types/${v.id}`, body);
        toast('Тип сохранён', 'success');
        await loadTypes();
        await onSaved?.();
        return true;
      },
    }],
  });
  const form = dlg.querySelector('#typeForm');
  let icon = v.icon;
  function readType(f) {
    return {
      name: f.name.value.trim(), code: f.code.value.trim(), color: f.color.value, icon,
      sort_order: Number(f.sort_order.value || 0), has_radius: f.has_radius.checked,
      default_radius_m: f.default_radius_m.value ? Number(f.default_radius_m.value) : null,
      fill_opacity: Number(f.fill_opacity.value), visible_default: f.visible_default.checked,
    };
  }
  const drawPreview = async () => {
    const t2 = readType(form);
    form.default_radius_m.disabled = !t2.has_radius;
    dlg.querySelector('#opOut').textContent = `${Math.round(t2.fill_opacity * 100)}%`;
    const cv = dlg.querySelector('#typePrev');
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#eef1f4';
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (t2.has_radius) {
      ctx.beginPath();
      ctx.arc(160, 95, 60, 0, Math.PI * 2);
      ctx.globalAlpha = t2.fill_opacity;
      ctx.fillStyle = t2.color;
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = t2.color;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const m = await markerCanvas({ icon, color: t2.color });
    ctx.drawImage(m, 160 - 15, 95 - 40, 30, 40);
  };
  form.addEventListener('input', drawPreview);
  dlg.querySelector('#iconPicker').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-icon]');
    if (!b) return;
    icon = b.dataset.icon;
    dlg.querySelectorAll('.icon-choice').forEach((x) => x.classList.toggle('active', x === b));
    drawPreview();
  });
  dlg.querySelector('#iconUpload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await request('POST', '/api/icons', fd);
      icon = r.icon;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'icon-choice';
      b.dataset.icon = r.icon;
      b.innerHTML = glyphSvg(r.icon, '#333', 22);
      e.target.closest('label').before(b);
      b.click();
    } catch (ex) { fail(ex); }
  });
  drawPreview();
}

// ================================================================ ПОЛЬЗОВАТЕЛИ

async function renderUsers() {
  const users = await api.get('/api/users');
  view.innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2>Пользователи</h2><button class="btn primary" id="addUser">Добавить пользователя</button></div>
      <div class="table-wrap"><table class="table hover">
        <thead><tr><th>Логин</th><th>Имя</th><th>Роль</th><th>Статус</th><th>Создан</th></tr></thead>
        <tbody>${users.map((u) => `<tr data-id="${u.id}">
          <td><b>${esc(u.login)}</b></td><td>${esc(u.full_name)}</td><td>${ROLE_NAME[u.role]}</td>
          <td>${u.active ? 'активен' : '<span class="muted">отключён</span>'}</td><td>${fmtDate(u.created_at)}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small">Наблюдатель — только карта. Оператор — импорт и объекты. Администратор — ещё типы, пользователи и настройки.</p>
    </section>`;
  document.getElementById('addUser').addEventListener('click', () => editUser(null));
  view.querySelector('tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) editUser(users.find((u) => u.id === Number(tr.dataset.id)));
  });
}

function editUser(u) {
  const isNew = !u;
  const v = { login: '', full_name: '', role: 'viewer', active: true, ...(u || {}) };
  modal(isNew ? 'Новый пользователь' : `Пользователь: ${v.login}`, `
    <form id="userForm" class="form-grid">
      <label>Логин *<input name="login" value="${esc(v.login)}" required pattern="[A-Za-z0-9_.\\-@]+" minlength="2"></label>
      <label>Имя<input name="full_name" value="${esc(v.full_name)}"></label>
      <label>Роль<select name="role">${Object.entries(ROLE_NAME).map(([k, n]) => `<option value="${k}" ${k === v.role ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>${isNew ? 'Пароль *' : 'Новый пароль'}<input name="password" type="password" minlength="8" ${isNew ? 'required' : ''} autocomplete="new-password" placeholder="${isNew ? '' : 'оставьте пустым, чтобы не менять'}"></label>
      <label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Активен</label>
    </form>`, {
    actions: [
      ...(isNew ? [] : [{
        label: 'Удалить',
        kind: 'danger left',
        onClick: async () => {
          if (!(await confirmDialog('Удалить пользователя?', `«${v.login}» будет удалён.`, 'Удалить'))) return false;
          await api.del(`/api/users/${v.id}`);
          renderUsers();
          return true;
        },
      }]),
      { label: 'Отмена' },
      {
        label: 'Сохранить',
        kind: 'primary',
        onClick: async (w) => {
          const f = w.querySelector('#userForm');
          if (!f.reportValidity()) return false;
          const body = {
            login: f.login.value.trim(), full_name: f.full_name.value.trim() || null, role: f.role.value,
            active: f.active.checked, password: f.password.value || null,
          };
          if (isNew) await api.post('/api/users', body);
          else await api.put(`/api/users/${v.id}`, body);
          toast('Сохранено', 'success');
          renderUsers();
          return true;
        },
      },
    ],
  });
}

// ================================================================ НАСТРОЙКИ

async function renderSettings() {
  settingsCache = null;
  const s = await settings();
  view.innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2>Настройки карты</h2></div>
      <form id="setForm">
        <div class="form-grid">
          <label>Широта центра<input name="center_lat" value="${s.center_lat}" required></label>
          <label>Долгота центра<input name="center_lon" value="${s.center_lon}" required></label>
          <label>Начальный масштаб<input name="zoom" type="number" step="0.5" min="0" max="20" value="${s.zoom}" required></label>
          <label>Радиус объединения в кластер, px<input name="cluster_radius" type="number" min="10" max="200" value="${s.cluster_radius}" required></label>
          <label>Кластеризация до масштаба<input name="cluster_max_zoom" type="number" min="5" max="20" value="${s.cluster_max_zoom}" required>
            <span class="muted small">Начиная со следующего масштаба маркеры не объединяются</span></label>
          <label>Поля для фильтров<input name="filter_attributes" value="${esc((s.filter_attributes || []).join(', '))}" placeholder="Ответственный, Регион">
            <span class="muted small">Названия колонок Excel через запятую, до 5 — по ним появятся фильтры на карте и в «Объектах»</span></label>
        </div>
        <p class="muted small">Подвиньте карту в нужное место и нажмите «Взять с карты».</p>
        <div class="minimap" id="setMap"></div>
        <div class="actions-row">
          <button type="button" class="btn" id="fromMap">Взять с карты</button>
          <button class="btn primary" type="submit">Сохранить</button>
        </div>
      </form>
    </section>`;
  const form = document.getElementById('setForm');
  const map = await miniMap('setMap', { center: [s.center_lon, s.center_lat], zoom: s.zoom });
  document.getElementById('fromMap').addEventListener('click', () => {
    const c = map.getCenter();
    form.center_lat.value = c.lat.toFixed(6);
    form.center_lon.value = c.lng.toFixed(6);
    form.zoom.value = Math.round(map.getZoom() * 2) / 2;
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = (k) => Number(String(form[k].value).replace(',', '.'));
    try {
      settingsCache = await api.put('/api/settings', {
        center_lat: n('center_lat'), center_lon: n('center_lon'), zoom: n('zoom'),
        cluster_radius: n('cluster_radius'), cluster_max_zoom: n('cluster_max_zoom'),
        filter_attributes: form.filter_attributes.value.split(',').map((x) => x.trim()).filter(Boolean),
      });
      toast('Настройки сохранены', 'success');
    } catch (ex) { fail(ex); }
  });
}

// ================================================================ ЖУРНАЛ

const AUDIT_ACTION = {
  login: 'Вход', password: 'Смена пароля', create: 'Создание', update: 'Изменение', delete: 'Удаление',
  bulk_delete: 'Массовое удаление', export_html: 'Выгрузка карты в HTML', bulk_type: 'Массовая смена типа', import: 'Импорт', rollback: 'Откат импорта', upload: 'Загрузка',
};
const AUDIT_ENTITY = {
  user: 'Пользователь', map_object: 'Объект', object_type: 'Тип', import_batch: 'Импорт', settings: 'Настройки', icon: 'Иконка',
};
const auditState = { page: 1, entity: '' };

function auditDetails(a) {
  const d = a.details;
  if (!d) return '';
  if (a.action === 'import') return `${esc(d.file)}: +${d.added}, изм. ${d.updated}, удал. ${d.deleted}, ошибок ${d.errors}`;
  if (a.action === 'rollback') return `${esc(d.file)}: удалено ${d.removed}, восстановлено ${d.restored}`;
  if (a.action === 'update' && a.entity === 'map_object') {
    return Object.entries(d).map(([k, [from, to]]) => `${esc(k)}: ${esc(JSON.stringify(from))} → ${esc(JSON.stringify(to))}`).join('<br>');
  }
  const s = JSON.stringify(d);
  return esc(s.length > 200 ? `${s.slice(0, 200)}…` : s);
}

async function renderAudit() {
  view.innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2>Журнал изменений</h2>
        <select id="aEntity"><option value="">Все записи</option>
          ${Object.entries(AUDIT_ENTITY).map(([k, n]) => `<option value="${k}" ${k === auditState.entity ? 'selected' : ''}>${n}</option>`).join('')}</select>
      </div>
      <div class="table-wrap" id="auditTable"><p class="muted">Загрузка…</p></div>
      <div id="auditPager"></div>
    </section>`;
  document.getElementById('aEntity').addEventListener('change', (e) => { auditState.entity = e.target.value; auditState.page = 1; loadAudit(); });
  loadAudit();
}

async function loadAudit() {
  const p = new URLSearchParams({ page: auditState.page, page_size: 50 });
  if (auditState.entity) p.set('entity', auditState.entity);
  const { total, items } = await api.get(`/api/audit?${p}`);
  document.getElementById('auditTable').innerHTML = `<table class="table">
    <thead><tr><th>Время</th><th>Пользователь</th><th>Действие</th><th>Что</th><th>ID</th><th>Подробности</th></tr></thead>
    <tbody>${items.map((a) => `<tr><td class="nowrap">${fmtDate(a.at)}</td><td>${esc(a.user_login)}</td>
      <td>${AUDIT_ACTION[a.action] || esc(a.action)}</td><td>${AUDIT_ENTITY[a.entity] || esc(a.entity)}</td>
      <td>${esc(a.entity_id)}</td><td class="small">${auditDetails(a)}</td></tr>`).join('')}</tbody></table>`;
  const pg = document.getElementById('auditPager');
  pg.innerHTML = '';
  pg.append(pager(total, auditState.page, 50, (n) => { auditState.page = n; loadAudit(); }));
}

// ================================================================ навигация

function changePassword() {
  modal('Смена пароля', `
    <form id="pwForm" class="form-grid">
      <label>Текущий пароль<input name="old" type="password" required autocomplete="current-password"></label>
      <label>Новый пароль<input name="new" type="password" minlength="8" required autocomplete="new-password"></label>
    </form>`, {
    actions: [{ label: 'Отмена' }, {
      label: 'Сменить',
      kind: 'primary',
      onClick: async (w) => {
        const f = w.querySelector('#pwForm');
        if (!f.reportValidity()) return false;
        await api.post('/api/auth/password', { old_password: f.old.value, new_password: f.new.value });
        toast('Пароль изменён', 'success');
        return true;
      },
    }],
  });
}

const ROUTES = {
  import: renderImport, objects: renderObjects, types: renderTypes, users: renderUsers, settings: renderSettings, audit: renderAudit,
};

async function route() {
  const [tab, arg] = (location.hash.slice(1) || 'import').split('/');
  const link = document.querySelector(`[data-tab="${tab}"]`);
  const target = ROUTES[tab] && link && !link.hidden ? tab : 'import';
  document.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === target));
  view.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    await ROUTES[target](arg);
  } catch (e) {
    view.innerHTML = `<p class="form-error">${esc(e.message)}</p>`;
  }
}

async function init() {
  const user = await ensureLogin();
  if (!can('operator')) {
    document.body.innerHTML = '<main class="admin-main"><p>Панель управления доступна операторам и администраторам. <a href="/">Вернуться к карте</a></p></main>';
    return;
  }
  document.getElementById('userName').textContent = user.full_name || user.login;
  document.getElementById('userName').addEventListener('click', changePassword);
  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.querySelectorAll('[data-role]').forEach((a) => { a.hidden = !can(a.dataset.role); });
  await loadTypes();
  window.addEventListener('hashchange', () => {
    if (!location.hash.startsWith('#objects') || !document.getElementById('objTable')) route();
    else {
      const [, arg] = location.hash.slice(1).split('/');
      if (arg) editObject(Number(arg));
    }
  });
  route();
}

init().catch(fail);
