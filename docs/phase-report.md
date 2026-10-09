# Итоги фаз 0–1

## Фаза 0

Аудит исходного HEAD: только README, без существующей архитектуры или пользовательских изменений. Созданы ADR, модель сущностей, геометрический контракт в метрах, project.json v1, нормализованный SQL blueprint с owner-based RLS, offline/sync и test strategies, карта всех 64 разделов требований, CI и проверяемая тестовая инфраструктура.

## Фаза 1

React/TypeScript/Vite PWA, маршруты проектов и этажей. Гостевой объект → первый этаж → пустой лист. Поиск, сортировка, переименование, архив, корзина с подтверждением и восстановление; добавление/выбор этажей. Dexie-транзакции сохраняют команды немедленно; ошибки не изображаются успешным сохранением. Нет автодемонстрации и неработающих инструментов. Будущий редактор явно отмечен TODO.

## Валидация финального состояния

- Повторный npm ci по lockfile: успешно.
- npm run typecheck: успешно.
- npm run lint: успешно.
- npm test: 18 из 18 успешно, два test files.
- npm run build: успешно, manifest + sw + 8 precache entries.
- Playwright на /usr/bin/chromium: 4 из 4 успешно, desktop и mobile viewport. Проверены empty plan, второй этаж, создание этажа offline, offline reload, реальный network failure, rename/search/archive/trash/restore и отсутствие горизонтального переполнения workspace.
- Запуск dev и preview: успешно; HTTP shell, manifest и sw доступны.
- Визуально проверены 1366×768 и 390×844. Реальные устройства, Safari/Edge/Opera не проверены.
- npm audit --omit=dev: 0 vulnerabilities на момент проверки. Не заменяет security QA.

## Ограничения

Geometry core/редактор, Undo/Redo, расчёты, cloud/Auth/sync, дефекты/фото, 3D, документы и exports — следующие фазы. SQL не применён и не проверен на реальном PostgreSQL/Supabase. JSON roundtrip проверен, UI import/export пока нет. Корзина без автоматической очистки 30 дней, копирование проекта пока не реализовано. В браузерной сетевой эмуляции Chromium после SW reload navigator.onLine может вернуть true при фактически заблокированной сети; см. testing.md. Гостевые данные только в конкретном браузере, облачного backup нет. Публичный запуск и критерии всего MVP пока не выполнены.

## Среда

install_script и start_skill сохранены в черновике cloud-конфигурации; это не публикация и не проверка восстановления новой задачи. Дополнительные сетевые домены не требуются, используется существующий Chromium. Dev запущен на 5173, production preview на 4173 для локальной проверки.

## Изменённые и добавленные файлы

README.md изменён; остальные перечисленные файлы добавлены. node_modules/dist — игнорируемые локальные результаты; package-lock.json фиксирует зависимости.

- `.github/workflows/ci.yml`
- `.gitignore`
- `.prettierignore`
- `README.md`
- `docs/adr/0001-architecture.md`
- `docs/data-and-sync.md`
- `docs/requirements.md`
- `docs/testing.md`
- `eslint.config.js`
- `index.html`
- `package-lock.json`
- `package.json`
- `playwright.config.ts`
- `public/icon-192.png`
- `public/icon-512.png`
- `public/icon.svg`
- `src/app/App.tsx`
- `src/app/format.ts`
- `src/app/messages.ts`
- `src/app/styles.css`
- `src/domain/model.ts`
- `src/domain/projects.ts`
- `src/domain/snapshot.ts`
- `src/features/projects/Projects.tsx`
- `src/features/projects/Workspace.tsx`
- `src/geometry/primitives.ts`
- `src/infrastructure/database.ts`
- `src/main.tsx`
- `supabase/migrations/0001_initial.sql`
- `tests/domain.test.ts`
- `tests/e2e/projects.spec.ts`
- `tests/setup.ts`
- `tests/storage.test.ts`
- `tsconfig.json`
- `vite.config.ts`
- `docs/phase-report.md`
