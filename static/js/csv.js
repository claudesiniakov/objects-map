// Импорт объектов из CSV и GeoJSON в скачанной HTML-странице (без сервера).
import { GeometryError, areaM2, labelPoint, parseGeometry } from './geo.js';
// Колонки — как в шаблоне импорта сервиса; остальные колонки становятся дополнительными полями.

const CSV_FIELDS = {
  external_id: ['id', 'ид', 'внешний id', 'внешний ид', 'код объекта', 'external_id'],
  contract_number: ['номер договора', '№ договора', 'договор', 'договор №', 'номер контракта', 'contract', 'contract_number'],
  cadastral_number: ['кадастровый номер', 'кадастровый №', 'кад. номер', 'кадастр', 'кн', 'cadastral_number', 'cadastral number'],
  cost: ['стоимость', 'стоимость, тыс. руб.', 'стоимость, тыс. руб', 'стоимость (тыс. руб.)', 'стоимость тыс. руб.', 'стоимость тыс руб', 'стоимость, тыс.', 'цена', 'cost'],
  type: ['тип', 'type', 'тип объекта', 'вид'],
  name: ['название', 'наименование', 'name', 'имя', 'объект'],
  lat: ['широта', 'lat', 'latitude', 'y', 'широта (lat)', 'широта (центр)'],
  lon: ['долгота', 'lon', 'lng', 'long', 'longitude', 'x', 'долгота (lon)', 'долгота (центр)'],
  geometry: ['геометрия (geojson)', 'геометрия', 'geometry', 'geojson', 'контур'],
  address: ['адрес', 'address', 'местоположение'],
  radius_m: ['радиус', 'радиус, м', 'радиус (м)', 'радиус м', 'radius', 'radius_m', 'радиус зоны'],
  description: ['описание', 'description', 'комментарий', 'примечание'],
  source: ['источник', 'source'],
};
const MAX_RADIUS_M = 100000;
const UNKNOWN_TYPE_COLOR = '#9e9e9e';

/** Текст файла: UTF-8, а если файл не в UTF-8 — Windows-1251 (так сохраняет CSV Excel в русской Windows). */
export async function readCsvFile(file) {
  const buf = await file.arrayBuffer();
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('windows-1251').decode(buf);
  }
  return text.replace(/^\uFEFF/, '');
}

function detectDelimiter(text) {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const counts = [';', ',', '\t'].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ';';
}

/** Разбор CSV по RFC 4180: кавычки, удвоенные кавычки, переводы строк внутри кавычек. */
export function parseCsv(text) {
  const d = detectDelimiter(text);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows; // пустые строки пропускаются при разборе объектов, чтобы номера строк совпадали с Excel
}

function num(v) {
  const s = String(v ?? '').replace(/[\s\u00a0]/g, '').replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function attrValue(v) {
  const n = num(v);
  // «500» и «12,5» становятся числами, как при импорте из Excel; телефоны и коды с ведущими нулями остаются текстом.
  if (Number.isFinite(n) && !/^0\d/.test(v.trim()) && !/^\+/.test(v.trim())) return n;
  return v;
}

/**
 * Превращает строки CSV в объекты карты.
 * types — справочник страницы; неизвестные типы добавляются серыми (newTypes).
 * Возвращает { objects, newTypes, errors: [{row, message}], columns }.
 */
export function csvToObjects(rows, types, nextId, fileName) {
  if (rows.filter((r) => r.some((c) => c.trim() !== '')).length < 2) throw new Error('В файле нет строк с данными (первая строка — заголовки)');
  const headers = rows[0].map((h, i) => h.trim() || `Колонка ${i + 1}`);
  const col = {};
  const attrCols = [];
  headers.forEach((h, i) => {
    const key = h.toLowerCase();
    const field = Object.keys(CSV_FIELDS).find((f) => CSV_FIELDS[f].includes(key) && !(f in col));
    if (field) col[field] = i;
    else attrCols.push([i, h]);
  });
  // С колонкой геометрии координаты не обязательны — маркер ставится посередине полигона.
  const missing = ['name', 'lat', 'lon'].filter((f) => !(f in col) && !(f !== 'name' && 'geometry' in col));
  if (missing.length) {
    const names = { name: 'Название', lat: 'Широта', lon: 'Долгота' };
    throw new Error(`Нет обязательных колонок: ${missing.map((f) => names[f]).join(', ')}`);
  }

  const typeIndex = new Map();
  for (const t of types) {
    typeIndex.set(String(t.code).toLowerCase(), t);
    typeIndex.set(t.name.toLowerCase(), t);
  }
  const newTypes = [];
  let nextTypeId = Math.min(0, ...types.map((t) => t.id)) - 1;
  const typeFor = (raw) => {
    const name = raw.trim() || 'Без типа';
    let t = typeIndex.get(name.toLowerCase());
    if (!t) {
      t = {
        id: nextTypeId, code: name, name, icon: 'circle', color: UNKNOWN_TYPE_COLOR, has_radius: false,
        default_radius_m: null, fill_opacity: 0.2, sort_order: 1000 + newTypes.length, visible_default: true, unknown: true,
      };
      nextTypeId -= 1;
      newTypes.push(t);
      typeIndex.set(name.toLowerCase(), t);
    }
    return t;
  };

  const objects = [];
  const errors = [];
  const now = new Date().toISOString();
  rows.slice(1).forEach((r, k) => {
    const rowNo = k + 2;
    if (!r.some((c) => c.trim() !== '')) return;
    const get = (f) => (f in col ? (r[col[f]] ?? '').trim() : '');
    const name = get('name');
    let lat = num(get('lat'));
    let lon = num(get('lon'));
    const problems = [];
    let geometry = null;
    try {
      geometry = parseGeometry(get('geometry'));
    } catch (e) {
      if (!(e instanceof GeometryError)) throw e;
      problems.push(`геометрия: ${e.message}`);
    }
    if (geometry && (lat === null || lon === null)) [lat, lon] = labelPoint(geometry);
    if (!name) problems.push('нет названия');
    if (lat === null || lon === null) problems.push('нет координат');
    else if (Number.isNaN(lat) || Number.isNaN(lon)) problems.push('координаты не числа');
    else if (Math.abs(lat) > 90 || Math.abs(lon) > 180) problems.push('координаты вне диапазона');
    if (problems.length) {
      errors.push({ row: rowNo, message: problems.join(', ') });
      return;
    }
    let radius = num(get('radius_m'));
    if (radius !== null && !(Number.isInteger(radius) && radius >= 1 && radius <= MAX_RADIUS_M)) {
      errors.push({ row: rowNo, message: `радиус «${get('radius_m')}» не учтён (нужно целое 1–${MAX_RADIUS_M})` });
      radius = null;
    }
    let cost = num(get('cost'));
    if (cost !== null && !(cost >= 0)) {
      errors.push({ row: rowNo, message: `стоимость «${get('cost')}» не учтена (нужно число тыс. руб. ≥ 0)` });
      cost = null;
    }
    const t = typeFor(get('type'));
    if (t.unknown && radius) {
      t.has_radius = true; // у неизвестного типа зона рисуется по радиусу из файла
    }
    const attributes = {};
    for (const [i, h] of attrCols) {
      const v = (r[i] ?? '').trim();
      if (v !== '') attributes[h] = attrValue(v);
    }
    objects.push({
      id: nextId + objects.length,
      external_id: get('external_id') || null,
      contract_number: get('contract_number') || null,
      cadastral_number: get('cadastral_number') || null,
      cost,
      type_id: t.id,
      name,
      address: get('address') || null,
      lat,
      lon,
      radius_m: radius,
      description: get('description') || null,
      attributes,
      source: get('source') || null,
      geometry,
      area_m2: geometry ? Math.round(areaM2(geometry) * 10) / 10 : null,
      import_file: fileName || null,
      import_at: now,
      updated_at: now,
    });
  });
  // Радиус считаем после разбора всех строк: неизвестный тип получает зону, если хоть у одного объекта есть радиус.
  const byType = new Map([...types, ...newTypes].map((t) => [t.id, t]));
  for (const o of objects) {
    const t = byType.get(o.type_id);
    // У полигона своя площадь: радиус типа по умолчанию к нему не применяется (как на сервере).
    o.effective_radius_m = t.has_radius ? (o.radius_m || (o.geometry ? null : t.default_radius_m) || null) : null;
  }
  return { objects, newTypes, errors, columns: headers };
}
