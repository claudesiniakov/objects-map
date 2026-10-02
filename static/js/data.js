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
  canComment: true,
  comments: (id) => api.get(`/api/objects/${id}/comments`),
  addComment: (id, text) => api.post(`/api/objects/${id}/comments`, { text }),
  deleteComment: (commentId) => api.del(`/api/comments/${commentId}`),
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
  let types = snap.types;
  let objects = snap.objects;
  let typeById;
  let byId;
  let features;
  let searchText;
  let typeCounts;

  // Индексы пересчитываются после импорта CSV.
  function reindex() {
    typeById = new Map(types.map((t) => [t.id, t]));
    byId = new Map(objects.map((o) => [o.id, o]));
    features = objects.map((o) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [o.lon, o.lat] },
      properties: {
        id: o.id, t: o.type_id, n: o.name, s: o.source, r: o.effective_radius_m,
        a: attrNames.map((name) => attrText(o.attributes?.[name])),
      },
    }));
    searchText = new Map(objects.map((o) => [o.id, [o.name, o.address, o.external_id, o.contract_number, o.cadastral_number].filter(Boolean).join(' ').toLowerCase()]));
    typeCounts = countBy(objects, (o) => o.type_id);
  }
  reindex();

  return {
    mode: 'snapshot',
    meta: snap.meta,
    init: async () => null,
    settings: async () => snap.settings,
    types: async () => types.map((t) => ({ ...t, objects: typeCounts.get(t.id) || 0 })),
    sources: async () => [...countBy(objects.filter((o) => o.source), (o) => o.source)]
      .sort(([a], [b]) => a.localeCompare(b, 'ru'))
      .map(([source, n]) => ({ source, objects: n })),
    objects: async () => ({ type: 'FeatureCollection', features }),
    object: async (id) => {
      const o = byId.get(id);
      if (!o) throw new Error('Объекта нет на карте');
      return { ...o, type_name: typeById.get(o.type_id)?.name };
    },
    search: async (q) => {
      const needle = q.trim().toLowerCase();
      return objects
        .filter((o) => searchText.get(o.id).includes(needle))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
        .slice(0, 20)
        .map((o) => ({ ...o, type_name: typeById.get(o.type_id)?.name }));
    },
    attributeValues: async (name) => {
      const counts = countBy(objects, (o) => attrText(o.attributes?.[name]));
      return [...counts]
        .sort(([a], [b]) => (a === null) - (b === null) || String(a).localeCompare(String(b), 'ru'))
        .map(([value, n]) => ({ value, objects: n }));
    },
    // Комментарии в выгрузке — снимок на момент скачивания, только для чтения.
    canComment: false,
    comments: async (id) => (byId.get(id)?.comments || []).map((c) => ({ ...c, can_delete: false })),
    count: () => objects.length,
    nextId: () => objects.reduce((m, o) => Math.max(m, o.id), 0) + 1,
    rawTypes: () => types,
    /** Импорт из CSV: replace — заменить все объекты; иначе добавить, обновляя объекты с тем же ID. */
    importObjects(newObjects, newTypes, replace) {
      types = [...types, ...newTypes];
      if (replace) {
        objects = newObjects;
      } else {
        const incoming = new Map(newObjects.filter((o) => o.external_id).map((o) => [o.external_id, o]));
        const kept = objects.filter((o) => !(o.external_id && incoming.has(o.external_id)));
        objects = [...kept, ...newObjects];
      }
      const used = new Set(objects.map((o) => o.type_id));
      types = types.filter((t) => !t.unknown || used.has(t.id)); // серые типы без объектов убираем
      reindex();
    },
  };
}

export function createProvider() {
  return window.OBJMAP_SNAPSHOT ? snapshotProvider(window.OBJMAP_SNAPSHOT) : liveProvider;
}
