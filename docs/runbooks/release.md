---
id: "objects-map.release"
canonical_id: "objects-map.release"
title: "Запуск и восстановление: Карта объектов"
type: "runbook"
status: "draft"
owner: "Dmitry Dorogov"
scope: "claudesiniakov/objects-map"
applies_to: "3223849cbe3f800021b722fc27f2a284e04c902c"
sources: [{"purpose": "Закреплённые Python dependencies", "repo": "claudesiniakov/objects-map", "path": "requirements.txt", "revision": "3223849cbe3f800021b722fc27f2a284e04c902c"}, {"purpose": "OBJMAP_DATA_DIR и ключ", "repo": "claudesiniakov/objects-map", "path": "backend/app/config.py", "revision": "3223849cbe3f800021b722fc27f2a284e04c902c"}, {"purpose": "Target process, worker и права", "repo": "claudesiniakov/objects-map", "path": "deploy/objects-map.service", "revision": "3223849cbe3f800021b722fc27f2a284e04c902c"}, {"purpose": "SQLite backup и ротация", "repo": "claudesiniakov/objects-map", "path": "deploy/backup.py", "revision": "3223849cbe3f800021b722fc27f2a284e04c902c"}, {"purpose": "Health и API smoke", "repo": "claudesiniakov/objects-map", "path": "backend/app/main.py", "revision": "3223849cbe3f800021b722fc27f2a284e04c902c"}]
evidence: {"source_revision": "3223849cbe3f800021b722fc27f2a284e04c902c", "runtime_status": "unverified"}
verified_at: "2026-11-04"
verification_boundary: "Проверена реализация на указанной версии; выполнение production-сценария требует отдельного допуска."
reviewed_at: null
production_status: "unverified"
---

## Локальная проверка без рабочих данных

В отдельном checkout создать собственное Python-окружение и установить закреплённые requirements.txt. Проверить свободный тестовый порт, например 4485, через lsof. Из каталога backend запустить `OBJMAP_DATA_DIR=/private/tmp/ddt1255-objects-map-test uvicorn app.main:app --host 127.0.0.1 --port 4485 --workers 1`. Выбранный data-каталог должен быть новым и принадлежать этой проверке: конфигурация создаёт в нём SQLite, imports/icons/backups и secret.key.

Проверить `/api/health` и отказ `/api/auth/me` без bearer token. Для полноценного API-импорта нужны отдельные тестовые пользователи/fixtures, не промышленная копия объектов. После согласованного тестового входа пройти upload → preview → commit → rollback одного batch и проверить API-выборку объектов. Команды записи в production в этот smoke не входят.

Эта команда поднимает только API: FastAPI в данном срезе не раздаёт `static/` frontend. Проверка карты в браузере требует отдельно согласованного HTTP-сервера UI и маршрута `/api` к этому тестовому backend. Готовый проверенный локальный путь такого UI здесь не установлен; до его подготовки не отмечать визуальную проверку карты или полный пользовательский import-сценарий как выполненный.

## Деплой-рецепт и реальность

`deploy/objects-map.service` описывает single-worker uvicorn на 127.0.0.1:8092, cwd `/var/www/objects-map/backend`, пользователя objmap и данные `/var/lib/objects-map`. Nginx/post-receive/timer — существующие рецепты. Их фактическая установка, current artifact и рабочий remote backend не подтверждены.

Перед выпуском оператор должен подтвердить эти пути/права/listener и точный approved artifact, отдельное разрешение restart/deployment, пригодный backup и совместимый предыдущий код. Не устанавливать systemd/nginx или менять сеть только для завершения документации. Не выдавать локальную команду uvicorn за перезапуск общего production.

## Копия и restore

Backup script использует SQLite backup API, затем gzip и 14-дневную ротацию. Этот файл покрывает базу, но не весь OBJMAP_DATA_DIR: imports, icons и secret.key требуют отдельного согласованного состава копии. Если ключ задан через OBJMAP_SECRET, он должен восстанавливаться из приватного хранилища; замена ключа влияет на прежние токены. Никакие значения ключа в отчёт не экспортируют.

Restore требует остановки всех writers, конкретной проверенной копии и совместимой schema; экспорт объектов и rollback batch не заменяют его. Полная внешняя репетиция не выполнена, поэтому универсальная команда восстановления не заявляется. При провале health/import остановить выпуск, сохранить исходный snapshot и безопасные диагностические сведения, не править рабочую SQLite напрямую.


## Реализация

- [Закреплённые Python dependencies](https://github.com/claudesiniakov/objects-map/blob/3223849cbe3f800021b722fc27f2a284e04c902c/requirements.txt)
- [OBJMAP_DATA_DIR и ключ](https://github.com/claudesiniakov/objects-map/blob/3223849cbe3f800021b722fc27f2a284e04c902c/backend/app/config.py)
- [Target process, worker и права](https://github.com/claudesiniakov/objects-map/blob/3223849cbe3f800021b722fc27f2a284e04c902c/deploy/objects-map.service)
- [SQLite backup и ротация](https://github.com/claudesiniakov/objects-map/blob/3223849cbe3f800021b722fc27f2a284e04c902c/deploy/backup.py)
- [Health и API smoke](https://github.com/claudesiniakov/objects-map/blob/3223849cbe3f800021b722fc27f2a284e04c902c/backend/app/main.py)
