import { PagedList } from "../components/PagedList";
import type { GeometryScene } from "../geometry/constraints";
import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { liveQuery } from "dexie";
import { Link, useLocation } from "react-router-dom";
import type { Floor } from "../domain/model";
import type { EditorStore } from "./store";
import { evaluateIssues, type PlanIssue } from "../issues/engine";
import { repository, sceneRepository } from "../infrastructure/database";
import type { SaveNotification } from "./save-queue";
interface FloorIssues {
  floor: Floor;
  issues: PlanIssue[];
  names: Record<string, string>;
}
const severityNames = {
  error: "Ошибка",
  warning: "Предупреждение",
  info: "Информация",
};
export function IssuesPanel({
  store,
  floor,
  saving,
}: {
  store: EditorStore;
  floor: Floor;
  saving: SaveNotification;
}) {
  const state = useStore(store),
    location = useLocation();
  const [saved, setSaved] = useState<FloorIssues[]>([]),
    [failed, setFailed] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState("all"),
    [review, setReview] = useState<string | null>(null),
    [declined, setDeclined] = useState<Record<string, string>>({});
  useEffect(() => {
    const subscription = liveQuery(async () => {
      const db = repository.db;
      return db.transaction(
        "r",
        [
          db.projects,
          db.floors,
          db.walls,
          db.junctions,
          db.dimensions,
          db.elements,
          db.rooms,
          db.sceneRevisions,
        ],
        async () => {
          const floors = await repository.floors(floor.projectId);
          return Promise.all(
            floors.map(async (f) => {
              const { scene } = await sceneRepository.load(f.id);
              return {
                floor: f,
                issues: evaluateIssues({
                  floorId: f.id,
                  scene,
                  height: f.defaultHeight,
                }),
                names: entityNames(scene),
              };
            }),
          );
        },
      );
    }).subscribe({
      next: (rows) => {
        setSaved(rows);
        setLoaded(true);
        setFailed(false);
      },
      error: () => setFailed(true),
    });
    return () => subscription.unsubscribe();
  }, [floor.projectId]);
  useEffect(() => {
    const target = (location.state as { issueTarget?: PlanIssue } | null)
      ?.issueTarget;
    if (target?.floorId === floor.id) store.getState().showIssue(target);
  }, [location.key, location.state, floor.id, store]);
  const rows = useMemo(() => {
    const current: FloorIssues = {
      floor,
      issues: state.issues,
      names: entityNames(state.scene),
    };
    if (saving.status === "conflict" || saving.status === "error")
      current.issues = [
        ...current.issues,
        {
          id: `${floor.id}:save`,
          ruleId:
            saving.status === "conflict" ? "version-conflict" : "save-error",
          floorId: floor.id,
          roomIds: [],
          elementIds: [],
          severity: "error",
          point: { x: 0, y: 0 },
          description:
            saving.status === "conflict"
              ? "Конфликт версий: другая вкладка сохранила новый план. Обе версии нужно сохранить отдельно."
              : "Локальное сохранение не подтверждено. Не закрывайте страницу; повторите сохранение.",
        },
      ];
    return [...saved.filter((row) => row.floor.id !== floor.id), current].sort(
      (a, b) => a.floor.order - b.floor.order,
    );
  }, [saved, floor, state.issues, state.scene, saving.status]);
  const all = rows.flatMap((row) =>
      row.issues.map((issue) => ({ row, issue })),
    ),
    visible = all.filter(
      ({ issue }) =>
        filter === "all" ||
        (filter === "current"
          ? issue.floorId === floor.id
          : issue.severity === filter),
    );
  function show(issue: PlanIssue) {
    if (issue.floorId === floor.id) store.getState().showIssue(issue);
  }
  return (
    <section className="issues-panel" aria-label="Нестыковки">
      <h2>
        Нестыковки <span className="issue-count">{all.length}</span>
      </h2>
      <p>
        Проверки не блокируют редактор. Исправления применяются только после
        вашего выбора.
      </p>
      <label>
        Показать нестыковки{" "}
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">Все этажи</option>
          <option value="current">Текущий этаж</option>
          <option value="error">Ошибки</option>
          <option value="warning">Предупреждения</option>
          <option value="info">Информация</option>
        </select>
      </label>
      {failed && (
        <p className="error">
          Не удалось прочитать другие этажи. Показаны проверки текущего плана;
          список объекта может быть неполным.
        </p>
      )}
      {!loaded && !failed && <p>Проверяем сохранённые этажи…</p>}
      {loaded && visible.length === 0 && (
        <p>В выбранном списке нестыковок нет.</p>
      )}
      <PagedList
        as="ul"
        className="issues-list"
        key={filter}
        label="Нестыковки"
        items={visible.map((entry) => ({ ...entry, id: entry.issue.id }))}
        render={({ issue, row }) => {
          const current = issue.floorId === floor.id,
            repair = issue.repair;
          return (
            <li
              key={issue.id}
              data-issue-rule={issue.ruleId}
              className={`issue-row issue-${issue.severity}`}
            >
              <div>
                <strong>{severityNames[issue.severity]}</strong> ·{" "}
                {row.floor.name} ·{" "}
                {issue.roomIds
                  .map((id) => row.names[id])
                  .filter(Boolean)
                  .join(", ") || "Без помещения"}
              </div>
              <small>
                Тип: {typeName(issue.ruleId)} · Элемент:{" "}
                {issue.elementIds
                  .map((id) => row.names[id] || "Связь недоступна")
                  .join(", ") || "Весь этаж"}
              </small>
              <p>{issue.description}</p>
              {current ? (
                <button
                  onClick={() => show(issue)}
                  aria-label={`Показать: ${issue.description}`}
                >
                  Показать
                </button>
              ) : (
                <Link
                  className="issue-show-link"
                  to={`/projects/${floor.projectId}/floors/${issue.floorId}`}
                  state={{ issueTarget: issue }}
                  aria-label={`Показать: ${issue.description}`}
                >
                  Показать
                </Link>
              )}
              {repair && current && declined[issue.id] !== repair.source && (
                <button onClick={() => setReview(issue.id + repair.source)}>
                  Предложение исправления
                </button>
              )}
              {repair &&
                current &&
                review === issue.id + repair.source &&
                declined[issue.id] !== repair.source && (
                  <div
                    className="repair-review"
                    role="group"
                    aria-label="Подтверждение исправления"
                  >
                    <strong>{repair.label}</strong>
                    <p>{repair.explanation}</p>
                    <p>Операция попадёт в историю Undo/Redo.</p>
                    <button
                      className="primary"
                      onClick={() => {
                        store.getState().repairIssue(repair);
                        setReview(null);
                      }}
                    >
                      Да, применить
                    </button>
                    <button
                      onClick={() => {
                        setDeclined({ ...declined, [issue.id]: repair.source });
                        setReview(null);
                      }}
                    >
                      Нет, оставить
                    </button>
                  </div>
                )}
              {repair && !current && (
                <small>
                  {" "}
                  Откройте этаж, чтобы проверить и применить предложение.
                </small>
              )}
            </li>
          );
        }}
      />
    </section>
  );
}

function entityNames(scene: GeometryScene): Record<string, string> {
  return Object.fromEntries([
    ...scene.walls.map((e, i) => [e.id, `Стена ${i + 1}`]),
    ...scene.dimensions.map((e, i) => [e.id, `Размер ${i + 1}`]),
    ...(scene.elements ?? []).map((e, i) => [
      e.id,
      `${{ column: "Колонна", opening: "Проём", beam: "Балка", stair: "Лестница", ramp: "Пандус", levelChange: "Перепад уровня" }[e.kind]} ${i + 1}`,
    ]),
    ...(scene.rooms ?? []).map((r) => [r.id, r.name || "Без названия"]),
  ]);
}
function typeName(rule: string): string {
  const names: Record<string, string> = {
    "small-wall-gap": "Разрыв стен",
    "open-wall-end": "Открытый контур",
    "duplicate-wall": "Дубликат стены",
    "wall-overlap": "Наложение стен",
    "wall-crossing": "Пересечение стен",
    opening: "Проём",
    "room-incomplete": "Помещение",
    "unregistered-room": "Неучтённое помещение",
    "incomplete-calculation": "Неполный расчёт",
    "level-mismatch": "Отметки уровня",
    "version-conflict": "Конфликт версий",
    "save-error": "Сохранение",
    "missing-measurement": "Нет размера",
    "element-overlap": "Наложение конструкций",
  };
  return names[rule] ?? "Связи и размеры";
}
