// «Скачать HTML»: одна самодостаточная страница с объектами, которые сейчас на экране с учётом фильтров.
// В неё встраиваются разметка карты, стили, скрипты и снимок данных; поиск, фильтры, кластеры и карточки
// работают по встроенным объектам без сервера (снаружи нужны только MapLibre с CDN и тайлы подложки).
import { api, confirmDialog, fmtNum, session, toast } from './api.js';
import { iconUrl } from './icons.js';

const BUNDLE = ['/js/api.js', '/js/icons.js', '/js/data.js', '/js/download.js', '/js/map.js'];
const LARGE = 20000;

async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Не удалось загрузить ${url} (${res.status})`);
  return res.text();
}

async function toDataUrl(url) {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// Модули склеиваются в один скрипт: строки import убираются (всё уже в общей области), export — снимается.
function stripModule(src) {
  return src.replace(/^import [^;]+;[ \t]*$/gm, '').replace(/^export (?=(async )?function |const |let |class )/gm, '');
}

function scriptSafe(text) {
  return text.replace(/<\/script/gi, '<\\/script');
}

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

// Библиотеку карты встраиваем в файл: у страницы, открытой с диска, запросы к CDN может блокировать
// браузер, антивирус или сеть — тогда не было бы ни карты, ни объектов. Не скачалась — остаётся ссылка на CDN.
async function inlineLibraries(doc) {
  const tags = doc.querySelectorAll('link[rel="stylesheet"][href^="https://"], script[src^="https://"]');
  await Promise.all([...tags].map(async (el) => {
    const isCss = el.tagName === 'LINK';
    try {
      const text = await fetchText(el.getAttribute(isCss ? 'href' : 'src'));
      const inline = doc.createElement(isCss ? 'style' : 'script');
      inline.textContent = isCss ? text : scriptSafe(text);
      el.replaceWith(inline);
    } catch { /* оставляем внешнюю ссылку */ }
  }));
}

// Запасной вариант на случай, если скрипты на странице не запустятся (просмотрщик без JavaScript).
function noscriptTable(doc, objects, types, attrNames) {
  const typeName = new Map(types.map((t) => [t.id, t.name]));
  const ns = doc.createElement('noscript');
  const wrap = doc.createElement('div');
  wrap.className = 'noscript-list';
  const h = doc.createElement('h1');
  h.textContent = `Объекты выгрузки (${objects.length}) — для карты откройте файл в браузере с включённым JavaScript`;
  const table = doc.createElement('table');
  const head = ['Название', 'Тип', 'ID', 'Адрес', 'Широта', 'Долгота', 'Радиус, м', ...attrNames];
  table.innerHTML = `<thead><tr>${head.map(() => '<th></th>').join('')}</tr></thead><tbody></tbody>`;
  table.querySelectorAll('th').forEach((th, i) => { th.textContent = head[i]; });
  const body = table.querySelector('tbody');
  for (const o of objects) {
    const tr = doc.createElement('tr');
    for (const v of [o.name, typeName.get(o.type_id), o.external_id, o.address, o.lat, o.lon, o.effective_radius_m,
      ...attrNames.map((n) => o.attributes?.[n])]) {
      const td = doc.createElement('td');
      td.textContent = v ?? '';
      tr.append(td);
    }
    body.append(tr);
  }
  wrap.append(h, table);
  ns.append(wrap);
  return ns;
}

export function describeFilters(state) {
  const parts = [];
  if (state.visible.size !== state.types.length) {
    const names = state.types.filter((t) => state.visible.has(t.id)).map((t) => t.name);
    parts.push(`типы: ${names.join(', ') || 'нет'}`);
  }
  if (state.source) parts.push(`источник: ${state.source}`);
  state.attrNames.forEach((name, i) => {
    const v = state.attrs[i];
    if (v) parts.push(`${name}: ${v === '__none__' ? 'не заполнено' : v}`);
  });
  return parts.join('; ');
}

export async function downloadSnapshot(map, state, button) {
  const bounds = map.getBounds();
  const inView = state.filtered.filter((f) => bounds.contains(f.geometry.coordinates));
  if (!inView.length) {
    toast('На экране нет объектов — измените масштаб или фильтры', 'error');
    return;
  }
  if (inView.length > LARGE && !(await confirmDialog('Большая выгрузка',
    `На экране ${fmtNum(inView.length)} объектов — файл получится большим и будет медленно открываться. Продолжить?`, 'Скачать', 'primary'))) {
    return;
  }
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Готовлю файл…';
  try {
    const objects = await api.post('/api/objects/details', { ids: inView.map((f) => f.properties.id) });
    const usedTypes = new Set(objects.map((o) => o.type_id));
    const types = await Promise.all(state.types.filter((t) => usedTypes.has(t.id)).map(async (t) => {
      const url = iconUrl(t.icon);
      return { ...t, icon_data: url ? await toDataUrl(url).catch(() => null) : null };
    }));
    const [indexHtml, css, ...modules] = await Promise.all(['/', '/css/app.css', ...BUNDLE].map(fetchText));

    const now = new Date();
    const c = map.getCenter();
    const filters = describeFilters(state);
    const snapshot = {
      meta: {
        created_at: now.toISOString(),
        created_by: session.user?.full_name || session.user?.login || '',
        origin: location.origin,
        filters,
        view: { center: [c.lng, c.lat], zoom: map.getZoom() },
      },
      settings: state.settings,
      types,
      objects,
    };

    const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
    doc.title = `Карта объектов — выгрузка ${now.toLocaleString('ru-RU')}`;
    const cssLink = doc.querySelector('link[href="/css/app.css"]');
    const style = doc.createElement('style');
    style.textContent = css;
    cssLink.replaceWith(style);
    doc.querySelectorAll('script[type="module"]').forEach((s) => s.remove());
    await inlineLibraries(doc);
    doc.body.prepend(noscriptTable(doc, objects, types, state.attrNames));
    const data = doc.createElement('script');
    data.textContent = `window.OBJMAP_SNAPSHOT = ${jsonForScript(snapshot)};`;
    const code = doc.createElement('script');
    code.type = 'module';
    code.textContent = scriptSafe(modules.map(stripModule).join('\n'));
    doc.body.append(data, code);

    const html = `<!doctype html>\n${doc.documentElement.outerHTML}`;
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `karta-obektov_${stamp(now)}.html` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(`Скачано объектов: ${fmtNum(objects.length)}`, 'success');
  } catch (e) {
    toast(e.message || String(e), 'error', 7000);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}
