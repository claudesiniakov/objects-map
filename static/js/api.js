// Общие функции: запросы к API, вход, уведомления, экранирование.

const TOKEN_KEY = 'objmap_token';
const USER_KEY = 'objmap_user';

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* приватный режим */ }
}

export const session = {
  token: storageGet(TOKEN_KEY),
  user: JSON.parse(storageGet(USER_KEY) || 'null'),
};

export const ROLE_LEVEL = { viewer: 1, operator: 2, admin: 3 };
export const ROLE_NAME = { viewer: 'Наблюдатель', operator: 'Оператор', admin: 'Администратор' };

export function can(role) {
  return session.user && ROLE_LEVEL[session.user.role] >= ROLE_LEVEL[role];
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function errorText(data, status) {
  if (data && typeof data.detail === 'string') return data.detail;
  if (data && Array.isArray(data.detail)) {
    return data.detail.map((d) => {
      const field = (d.loc || []).slice(1).join('.');
      const msg = (d.msg || '').replace(/^Value error, /, '');
      return field ? `${field}: ${msg}` : msg;
    }).join('; ');
  }
  return `Ошибка сервера (${status})`;
}

export async function request(method, path, body, { blob = false, retry = true } = {}) {
  const headers = {};
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, 'Нет связи с сервером');
  }
  if (res.status === 401 && retry && !path.startsWith('/api/auth/login')) {
    await showLogin('Войдите, чтобы продолжить');
    return request(method, path, body, { blob, retry: false });
  }
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { /* не JSON */ }
    throw new ApiError(res.status, errorText(data, res.status));
  }
  if (blob) return res;
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : res.text();
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b ?? {}),
  put: (p, b) => request('PUT', p, b),
  del: (p) => request('DELETE', p),
};

export async function download(path, fallbackName) {
  const res = await request('GET', path, undefined, { blob: true });
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/) || cd.match(/filename="?([^";]+)"?/);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------- уведомления

let toastBox;
export function toast(message, kind = 'info', ms = 4000) {
  if (!toastBox) {
    toastBox = document.createElement('div');
    toastBox.className = 'toasts';
    document.body.append(toastBox);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  toastBox.append(el);
  setTimeout(() => el.remove(), ms);
}

export function fail(err) {
  console.error(err);
  toast(err.message || String(err), 'error', 7000);
}

// ---------------------------------------------------------------- модальные окна

export function modal(title, bodyHtml, { wide = false, actions = [], onEscape = null } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Закрыть">×</button></div>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-foot"></div>
    </div>`;
  const foot = wrap.querySelector('.modal-foot');
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  // onEscape() → true: клавишу обработал сам диалог (например, отменил рисование), окно не закрываем.
  const onKey = (e) => {
    if (e.key !== 'Escape' || [...document.querySelectorAll('.modal-backdrop')].at(-1) !== wrap) return; // только верхнее окно
    if (onEscape?.()) return;
    close();
  };
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `btn ${a.kind || ''}`;
    b.textContent = a.label;
    b.addEventListener('click', async () => {
      if (!a.onClick) return close();
      b.disabled = true;
      try {
        if ((await a.onClick(wrap)) !== false) close();
      } catch (e) {
        fail(e);
      } finally {
        b.disabled = false;
      }
    });
    foot.append(b);
  }
  if (!actions.length) foot.remove();
  wrap.querySelector('[data-close]').addEventListener('click', close);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(wrap);
  wrap.close = close;
  const first = wrap.querySelector('input, select, textarea');
  if (first) first.focus();
  return wrap;
}

export function confirmDialog(title, text, okLabel = 'Подтвердить', kind = 'danger') {
  return new Promise((resolve) => {
    const m = modal(title, `<p>${esc(text)}</p>`, {
      actions: [
        { label: 'Отмена', onClick: () => resolve(false) },
        { label: okLabel, kind, onClick: () => resolve(true) },
      ],
    });
    m.querySelector('[data-close]').addEventListener('click', () => resolve(false));
  });
}

// ---------------------------------------------------------------- вход

let loginPromise = null;

export function showLogin(message = '') {
  if (loginPromise) return loginPromise;
  loginPromise = new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop login-backdrop';
    wrap.innerHTML = `
      <form class="modal login" autocomplete="on">
        <h1>Карта объектов</h1>
        <p class="muted">${esc(message || 'Вход в систему')}</p>
        <label>Логин<input name="login" autocomplete="username" required></label>
        <label>Пароль<input name="password" type="password" autocomplete="current-password" required></label>
        <p class="form-error" hidden></p>
        <button class="btn primary" type="submit">Войти</button>
      </form>`;
    const form = wrap.querySelector('form');
    const err = wrap.querySelector('.form-error');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      const fd = new FormData(form);
      try {
        const res = await request('POST', '/api/auth/login', { login: fd.get('login'), password: fd.get('password') }, { retry: false });
        session.token = res.token;
        session.user = res.user;
        storageSet(TOKEN_KEY, res.token);
        storageSet(USER_KEY, JSON.stringify(res.user));
        wrap.remove();
        loginPromise = null;
        resolve(res.user);
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    });
    document.body.append(wrap);
    form.querySelector('input').focus();
  });
  return loginPromise;
}

export async function ensureLogin() {
  if (session.token) {
    try {
      session.user = await request('GET', '/api/auth/me', undefined, { retry: false });
      storageSet(USER_KEY, JSON.stringify(session.user));
      return session.user;
    } catch { /* токен устарел */ }
  }
  await showLogin();
  return session.user;
}

export function logout() {
  session.token = null;
  session.user = null;
  storageSet(TOKEN_KEY, null);
  storageSet(USER_KEY, null);
  location.reload();
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Стоимость в тыс. руб. → «850 тыс. ₽», «12,4 млн ₽», «1,25 млрд ₽». */
export function fmtCost(thousands) {
  const v = Number(thousands) || 0;
  const f = (x) => x.toLocaleString('ru-RU', { maximumFractionDigits: x < 10 ? 2 : 1 });
  if (v >= 1e6) return `${f(v / 1e6)} млрд ₽`;
  if (v >= 1e3) return `${f(v / 1e3)} млн ₽`;
  return `${f(v)} тыс. ₽`;
}

/** Склонение по числу: plural(3, 'объект', 'объекта', 'объектов') → «объекта». */
export function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export function fmtNum(n) {
  return (n ?? 0).toLocaleString('ru-RU');
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
