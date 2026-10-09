# Фаза 2 — геометрическое ядро

## Результат

Реализован независимый от UI geometry core, экспортируемый через `src/geometry/index.ts`:

- точки/векторы, расстояние, устойчивые площадь и периметр;
- проекции и пересечения отрезков: none/point/overlap, включая вырожденные и почти параллельные случаи;
- матрицы преобразования, композиция/инверсия, перемещение/поворот вокруг pivot;
- создание стен с точной длиной, свободным/ортогональным направлением, вычисляемыми физическими краями;
- девять расширяемых snap-провайдеров с экранным радиусом, приоритетами, floor filtering и стабильным выбором;
- ассоциативные размеры start/end/center, считывание справочных и изменение управляющей длины одной стены;
- явные endpoint junctions, connect/detach, распространение координат, типизированные conflicts;
- атомарные команды: неудачная команда не содержит частично изменённой модели, manual lengths соседей не переписываются;
- безопасные изменения допускаются при несвязанных старых проблемах; оставшиеся проблемы возвращаются с результатом.

Код существующих проектов, этажей и IndexedDB сохранён. Изменены только поясняющие тексты UI: редактор рисования ещё не подключён. Добавлена математическая зависимость robust-predicates; версии/целостность зависимостей закреплены package-lock.json.

## Валидация

| Проверка                                                                 | Результат                                                   |
| ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `npm run typecheck`                                                      | успешно                                                     |
| `npm run lint`                                                           | успешно, без предупреждений                                 |
| `npm test`                                                               | 115/115 успешно, 6 test files; 18 прежних + 97 новых тестов |
| `npm run build`                                                          | успешно, PWA shell/manifest/service worker                  |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:e2e` | 4/4 успешно, desktop/mobile viewport                        |

Новые проверки используют аналитические эталоны, invariance при перестановке/повороте, сохранение чисел и frozen fixtures. Измеренный размер 4,257 сохраняется точно как исходный number; производная геометрия сравнивается с допуском существенно ниже 1% на проверенных случаях. Площадь прямоугольника 4,25×3 = 12,75 м² и после смещения на 1e9. Введённые значения не округляются для того, чтобы добиться совпадения геометрии. UI-регрессия включает offline creation/reload и archive/trash/restore.

## Ограничения и следующая фаза

- Canvas/zoom/pan/selection и редактирование на экране — Фаза 3. Сейчас пользователь по-прежнему открывает пустой лист.
- GeometryScene пока используется только в чистом API; Junction/Dimension не записываются в Dexie и snapshot v1. Перед сохранением редактором нужны schema migration и тесты восстановления в Фазе 3.
- Управляющие размеры только между противоположными концами одной стены. Универсального нелинейного CAD solver нет; несовместимые ограничения возвращают конфликт.
- Выделение помещений, holes, topology validation и строительные поверхности — Фаза 5. Функция площади предполагает корректный простой контур.
- Оконные/дверные constraints — Фаза 4; панель «Нестыковки» и предложения исправлений — Фаза 6.
- В плотном узле snap intersections остаются O(k²); viewport culling/spatial index и реальная проверка 5000 элементов ещё предстоят.
- Safari/Edge/Opera и реальные сенсорные устройства в этой фазе не проверялись. Браузерные сценарии — системный Chromium, мобильная эмуляция.
- Порядок фаз сохранён. Публичный запуск, cloud, 3D и exports не заявляются готовыми.

Подробный контракт: [ADR 0002](adr/0002-geometry-core.md). Следующая работа — Konva editor с command history, Undo/Redo и сохранением геометрических связей, без независимой модели для canvas.

## Файлы этой фазы

Изменены:

- `package.json`, `package-lock.json`;
- `src/domain/model.ts`;
- `src/geometry/primitives.ts`;
- `src/features/projects/Projects.tsx`, `src/features/projects/Workspace.tsx` (только тексты статуса);
- `README.md`, `docs/data-and-sync.md`, `docs/requirements.md`, `docs/testing.md`.

Добавлены:

- `src/geometry/vector.ts`;
- `src/geometry/segments.ts`;
- `src/geometry/transforms.ts`;
- `src/geometry/walls.ts`;
- `src/geometry/dimensions.ts`;
- `src/geometry/snapping.ts`;
- `src/geometry/constraints.ts`;
- `src/geometry/construction.ts`;
- `src/geometry/index.ts`;
- `tests/geometry/fixtures.ts`;
- `tests/geometry/segments.test.ts`;
- `tests/geometry/walls-transforms.test.ts`;
- `tests/geometry/snapping.test.ts`;
- `tests/geometry/constraints.test.ts`;
- `docs/adr/0002-geometry-core.md`;
- `docs/phase-2-report.md`.
