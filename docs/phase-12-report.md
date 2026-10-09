# Фаза 12: QA/Beta

Выполнена доступная автоматизированная часть. Найден и устранён bottleneck поиска комнат: на синтетической сцене одного этажа с 5000 стенами первоначально ~4,1 с, после conservative broad phase и spatial node lookup ~86 мс в отдельном запуске; при полном наборе с параллельными workers время выше. Точная геометрия, порядок обработки пар, epsilon, схемы и ручные значения сохраняются. Производительность реального планшета этим не подтверждается.

Culling распространён на все слои Konva; широкие стены учитываются по толщине. Фото, дефекты и нестыковки отображаются постранично по 24 записи с доступом ко всем результатам. В измеренном начальном viewport рисуются 7 из 250 стен этажа на laptop/tablet и 3 на phone (20 этажей/5000 стен в проекте). Исходная модель не обрезается при сохранении или export.

Синтетический ZIP recovery: 20 этажей, 5000 стен, 200 комнат, 1000 дефектов, 2000 разных маленьких PNG originals. Подтверждены переназначение ссылок, сохранение чисел и всех исходных байтов после reopen. Это fake IndexedDB storage test; browser previews и реальная квота 2000 camera originals не измерены. Браузерный большой набор использует native IndexedDB, те же геометрию/дефекты и 51 photo bindings с одним original.

Дополнительные проверки: exhaustive broad-phase oracle, EPS joins/large-coordinate fallback, 40 аналитических rotated-room/window cases с относительной ошибкой <0,000001, offline import/edit/reload, пагинация/filters, literal user markup без выполнения, PDF/ZIP и interrupted pointer gesture. Beta screens: laptop 1366×768, touch tablet 1024×768, touch phone 390×844. Добавлены scripts test:beta и test:beta:load, artifact metrics/screenshots, CI и ручной workflow Firefox/WebKit.

Проверки: 323 unit/storage/SQL/load теста в 22 файлах; 68 обычных browser сценариев (12 cloud skipped) + 12 отдельных Auth/RPC/Storage mocks + 9 Beta случаев. npm audit на дату проверки сообщает 0 известных уязвимостей; типы, lint, форматирование и production/PWA build проходят. Метрики — artifacts/beta-node-metrics.json и artifacts/beta-*-metrics.json; timings не являются FPS или результатами настоящего устройства.

Firefox/WebKit не установлены: официальный CDN вернул 403 Domain forbidden. Реальные Chrome/Safari/Edge/Opera, Android/iOS/stylus/GPU/камеры, live Supabase, HTTPS/rate limiting, infrastructure backup/restore и мониторинг остаются открытыми обязательными критериями. Публичный запуск не объявляется готовым. [Матрица выпуска](release-readiness.md), [ADR 0012](adr/0012-beta-validation.md).

Измерения browser synthetic набора в последнем запуске (не реальные устройства):

| Viewport       | Импорт и открытие текущего этажа | Проверки всех этажей от начала импорта | Видимые стены | JS heap sample |
| -------------- | -------------------------------- | -------------------------------------- | ------------- | -------------- |
| 1366×768       | 4,318 с                          | 5,776 с                                | 7 / 250       | 74,5 МБ        |
| 1024×768 touch | 4,243 с                          | 5,674 с                                | 7 / 250       | 73,0 МБ        |
| 390×844 touch  | 3,481 с                          | 4,927 с                                | 3 / 250       | 59,5 МБ        |

Последний полный Node запуск: single-floor topology 119 мс, ZIP validation 618 мс, запись копии 417 мс; весь synthetic recovery с созданием/проверкой 2000 файлов ~9,48 с. Значения отражают конкретный cloud CPU/run и не задают обещания для устройств.
