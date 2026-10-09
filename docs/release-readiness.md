# Готовность к Beta и публичному запуску

Дата проверки: 08.10.2026. Доступная автоматизированная часть фазы 12 выполнена. **Публичный запуск заблокирован непроверенными внешними критериями.** Supabase пользователь подключит позже. Фактического deployment, HTTPS домена, live backend и физических устройств в этой среде нет.

| Критерий                                              | Статус                        | Подтверждение / что осталось                                                                                                          |
| ----------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Типы, lint, build/PWA, форматирование                 | Проверено локально            | npm run check; npm run format:check                                                                                                   |
| Точность и сохранность ручных размеров                | Проверено на эталонах         | Включая повороты/координаты 1e9, дыры/проёмы/профили; 1% соблюдается для проверенных случаев                                          |
| XLSX ведомости, история и ZIP                         | Проверено автоматически       | Числовые сметы и пустые цены; offline desktop/mobile, импорт истории, независимый openpyxl; реальный Excel/LibreOffice UI не проверен |
| ZIP/recovery/квота/конфликты                          | Проверено автоматически       | Все байты 2000 synthetic originals после reopen; unit rollback + browser offline/конфликт/история                                     |
| Desktop/tablet/phone layouts                          | Проверено Chromium emulation  | 1366×768, 1024×768, 390×844; без horizontal overflow, pagination и pointercancel                                                      |
| Нагрузка 20 этажей/5000 стен/200 комнат/1000 дефектов | Проверено синтетически        | Node и браузер; реальные tablet CPU/GPU и плотные сцены ещё не проверены                                                              |
| 2000 фото в настоящем браузере/камеры/HEIC            | Не проверено                  | Node recovery содержит 2000 маленьких originals; browser workload — 51 bindings с одним original                                      |
| Реальные Chrome/Safari/Edge/Opera                     | Не проверено                  | Chromium core не равен тесту этих продуктов; Firefox/WebKit download blocked 403                                                      |
| Реальные Android/iOS/планшет/stylus                   | Не проверено                  | Touch emulation и mouse pointercancel не являются физическим stylus/iOS QA                                                            |
| Dependency audit и inert пользовательский текст       | Проверено в доступной области | npm audit: 0 известных advisories на дату проверки; literal markup не выполняется                                                     |
| Live HTTPS/Auth/RLS/private Storage                   | Отложено                      | Подключить Supabase по supabase-setup.md, затем live smoke с двумя пользователями                                                     |
| Rate limiting входа                                   | Не проверено                  | В deployment проверить Supabase Auth limits/CAPTCHA при необходимости; UI throttle не заменяет backend rate limit                     |
| Серверный backup/restore и lifecycle                  | Не проверено                  | Проверить независимый backup, восстановление из него и private originals на staging; version snapshots не заменяют backup             |
| Мониторинг внешней инфраструктуры                     | Не настроено                  | Перед выпуском выбрать канал ошибок Auth/sync/storage/export и политику без паролей/фото/содержимого проектов в логах                 |

## Воспроизводимый запуск

```sh
npm ci --cache /workspace/.npm-cache
npm run check
npm run format:check
npm audit
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:e2e -- --workers=2
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:beta
npm run test:beta:load
```

Browser тесты запускаются после build на неизменной dist. Node metrics в artifacts сохраняются отдельно от очищаемой Playwright папки test-results. CI сохраняет metrics/screenshots/traces; отчёты содержат synthetic=true. Не загружайте в QA artifacts реальные пользовательские фото или credentials.

На машине с доступом к официальным Playwright downloads:

```sh
npm exec playwright install --with-deps chromium firefox webkit
BETA_ALL_ENGINES=1 npm run test:beta
```

В GitHub подготовлен workflow `Beta browser engines` (workflow_dispatch); в этой задаче он не запускался. Для текущей cloud-среды нужны официальные CDN domains в настройках сети и применение этих настроек до повторной установки движков.

## Протокол физических устройств и staging

Для каждого устройства записать модель/OS/browser/version/RAM, дату, результаты, timings/CPU/GPU memory и шаги воспроизведения ошибок. Прогнать новый объект → точный замер → свободный угол/проём/колонна → помещение/нестыковки/Undo → камера/дефект → 3D → PDF/JPEG/ZIP → импорт отдельной копии → offline edit/reload → смена аккаунта/конфликт → проверка original hash. Отдельно stylus/pinch/cancel, landscape, 1366×768, 2000 реальных фото, HEIC, малый остаток диска и восстановление после закрытия браузера. Не удалять существующие данные ради теста квоты.

На staging с HTTPS проверить два разных пользователя: SDK Auth/reset/logout, запрет чтения/изменения чужих UUID, private bucket/URL, upload retry и lost ACK, старую revision/duplicate idempotency, actual rate limits без нагрузочной атаки, возврат из корзины с оригиналами, независимый backup restore. Supabase SQL применять только по инструкции и только ещё не применённые миграции. Пароли/service_role не помещать в PWA или QA evidence.

При критической потере данных, доступе к чужому объекту, систематических export failures или нестабильной базовой геометрии выпуск остановлен. После закрытия внешних критериев обновить эту таблицу конкретными доказательствами; deploy потребует отдельного запроса.
