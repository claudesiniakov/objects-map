// Источник данных карты. Онлайн — API сервиса; в скачанной HTML-странице — встроенный снимок
// window.OBJMAP_SNAPSHOT с тем же набором операций, поэтому код карты один для обоих режимов.
import { api, ensureLogin } from './api.js';

const liveProvider = {
  mode: 'live',
  init: () => ensureLogin(),
  settings: () => api.get('/api/settings'),
  types: () => api.get('/api/types'),
  sources: () => api.get('/api/sources'),
  objects: () => api.get('/api/objects'),
  object: (id) => api.get(`/api/objects/${id}`),
  search: (q) => api.get(`/api/search?q=${encodeURIComponent(q)}`),
  attributeValues: (name) => api.get(`/api/attribute-values?name=${encodeURIComponent(name)}`),
};

/** Значение поля так же, как его показывает сервер в фильтрах (attr_text). */
export function attrText(v) {
  if (v === null || v === undefined) return null;
  return String(v);
}

function countBy(items, key) {
  const m = new Map();
  for (const it of items) {
    const k = key(it);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

function snapshotProvider(snap) {
  const attrNames = snap.settings.filter_attributes || [];
  const typeById = new Map(snap.types.map((t) => [t.id, t]));
  const byId = new Map(snap.objects.map((o) => [o.id, o]));
  const features = snap.objects.map((o) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [o.lon, o.lat] },
    properties: {
      id: o.id, t: o.type_id, n: o.name, s: o.source, r: o.effective_radius_m,
      a: attrNames.map((name) => attrText(o.attributes?.[name])),
    },
  }));
  const searchText = new Map(snap.objects.map((o) => [o.id, [o.name, o.address, o.external_id].filter(Boolean).join(' ').toLowerCase()]));
  const typeCounts = countBy(snap.objects, (o) => o.type_id);
  return {
    mode: 'snapshot',
    meta: snap.meta,
    init: async () => null,
    settings: async () => snap.settings,
    types: async () => snap.types.map((t) => ({ ...t, objects: typeCounts.get(t.id) || 0 })),
    sources: async () => [...countBy(snap.objects.filter((o) => o.source), (o) => o.source)]
      .sort(([a], [b]) => a.localeCompare(b, 'ru'))
      .map(([source, objects]) => ({ source, objects })),
    objects: async () => ({ type: 'FeatureCollection', features }),
    object: async (id) => {
      const o = byId.get(id);
      if (!o) throw new Error('Объекта нет в выгрузке');
      return o;
    },
    search: async (q) => {
      const needle = q.trim().toLowerCase();
      return snap.objects
        .filter((o) => searchText.get(o.id).includes(needle))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
        .slice(0, 20)
        .map((o) => ({ ...o, type_name: typeById.get(o.type_id)?.name }));
    },
    attributeValues: async (name) => {
      const counts = countBy(snap.objects, (o) => attrText(o.attributes?.[name]));
      return [...counts]
        .sort(([a], [b]) => (a === null) - (b === null) || String(a).localeCompare(String(b), 'ru'))
        .map(([value, objects]) => ({ value, objects }));
    },
  };
}

export function createProvider() {
  return window.OBJMAP_SNAPSHOT ? snapshotProvider(window.OBJMAP_SNAPSHOT) : liveProvider;
}
