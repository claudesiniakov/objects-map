---
id: "objects-map.overview"
canonical_id: "objects-map.overview"
title: "Карта объектов"
type: "overview"
status: "draft"
owner: "Dmitry Dorogov"
scope: "claudesiniakov/objects-map"
applies_to: "3223849cbe3f800021b722fc27f2a284e04c902c"
sources: [{"purpose": "API ролей, объектов, import endpoints и export", "repo": "claudesiniakov/objects-map", "path": "backend/app/main.py", "revision": "3223849cbe3f800021b722fc27f2a284e04c902c"}, {"purpose": "Bearer auth и require(role)", "repo": "claudesiniakov/objects-map", "path": "backend/app/auth.py", "revision": "3223849cbe3f800021b722fc27f2a284e04c902c"}, {"purpose": "Preview/commit/rollback batch", "repo": "claudesiniakov/objects-map", "path": "backend/app/importer.py", "revision": "3223849cbe3f800021b722fc27f2a284e04c902c"}, {"purpose": "Data paths и пределы", "repo": "claudesiniakov/objects-map", "path": "backend/app/config.py", "revision": "3223849cbe3f800021b722fc27f2a284e04c902c"}]
evidence: {"source_revision": "3223849cbe3f800021b722fc27f2a284e04c902c", "runtime_status": "unverified"}
verified_at: "2026-11-04"
verification_boundary: "Проверена реализация на указанной версии; выполнение production-сценария требует отдельного допуска."
reviewed_at: null
production_status: "unverified"
---

Карта объектов — FastAPI/SQLite сервис для просмотра объектов на карте, поиска и работы с импортируемыми наборами. Статический frontend обращается к `/api`; viewer, operator и admin имеют разные серверные полномочия. Наличие deployment recipes в Git не подтверждает действующий удалённый экземпляр.

## Данные и роли

Viewer читает доступную карту, operator выполняет разрешённые изменения/импорт, admin управляет типами/настройками/пользователями. Вход `/api/auth/login` выдаёт bearer token; текущий пользователь дополнительно сверяется с активной записью БД. Токен истекает через 12 часов, отключённый пользователь не получает доступ только из старого token payload. Значения паролей/токенов в портал не помещают.

Объекты имеют координаты/геометрию, типы и атрибуты. Карта и детальная выборка разделены, есть фильтры/поиск, комментарии и свои pins. Геокодирование — отдельная внешняя операция, её не запускают с реальными адресами ради технического smoke.

## Импорт без слепой записи

Получить шаблон `GET /api/import/template`, подготовить разрешённый тестовый XLSX/CSV/GeoJSON и загрузить через `POST /api/import`. Перед preview задать `sheet`, `mapping` колонок и `source`; выбрать режим. `upsert` добавляет или обновляет сопоставленные объекты, `replace` заменяет набор выбранного источника и требует отдельной проверки исчезающих записей. Вызвать `/api/import/{id}/preview`: проверить количество/ошибки, координаты, типы и образец строк. Только после этого явно commit для выбранного batch. Errors/file endpoints позволяют изучить исходный пакет в своём разрешённом контуре; не публиковать его данные в документации.

Rollback разрешён только для последнего committed batch. Он восстанавливает прежние snapshots и удаляет созданные этим импортом объекты, **но не проверяет последующие ручные изменения этих объектов**. Поэтому ручные правки после commit могут быть потеряны; отсутствие отказа не доказывает безопасный возврат. До rollback нужно остановить изменения, сохранить согласованный snapshot и сверить затронутые объекты; при неизвестном состоянии не выполнять его. Это наблюдаемое ограничение реализации, не разрешение терять более новые данные. Ограничения upload — 20 MB, до 100000 строк; проверка структуры и preview предшествуют записи. Экспорт не является полной резервной копией пользователей, ключа, icons и истории импорта.

[Локальный запуск и восстановление](runbooks/release.md) раскрывают OBJMAP_DATA_DIR, ключ и состав копии. Удалённый production backend/version в доступном inventory не установлен; эту область нельзя объявить deployed по наличию systemd-файла.


## Реализация

- [API ролей, объектов, import endpoints и export](https://github.com/claudesiniakov/objects-map/blob/3223849cbe3f800021b722fc27f2a284e04c902c/backend/app/main.py)
- [Bearer auth и require(role)](https://github.com/claudesiniakov/objects-map/blob/3223849cbe3f800021b722fc27f2a284e04c902c/backend/app/auth.py)
- [Preview/commit/rollback batch](https://github.com/claudesiniakov/objects-map/blob/3223849cbe3f800021b722fc27f2a284e04c902c/backend/app/importer.py)
- [Data paths и пределы](https://github.com/claudesiniakov/objects-map/blob/3223849cbe3f800021b722fc27f2a284e04c902c/backend/app/config.py)
