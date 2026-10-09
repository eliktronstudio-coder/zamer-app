import { useEffect, useState } from "react";
import { liveQuery } from "dexie";
import { repository, sceneRepository } from "../../infrastructure/database";
import { CalculationEngine } from "../../calculation/engine";
import { calculateProject } from "../../calculation/project";
const format = (n: number) =>
  n.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
export function ProjectQuantities({ projectId }: { projectId: string }) {
  const [result, setResult] = useState<ReturnType<typeof calculateProject>>();
  const [failed, setFailed] = useState(false);
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
          const floors = await repository.floors(projectId);
          const quantities = await Promise.all(
            floors.map(async (floor) => {
              const { scene } = await sceneRepository.load(floor.id);
              return new CalculationEngine().evaluate(
                scene,
                floor.defaultHeight,
              ).floor;
            }),
          );
          return calculateProject(quantities);
        },
      );
    }).subscribe({
      next: (value) => {
        setResult(value);
        setFailed(false);
      },
      error: () => setFailed(true),
    });
    return () => subscription.unsubscribe();
  }, [projectId]);
  return (
    <details className="project-quantities">
      <summary>Сохранённые итоги объекта</summary>
      {failed ? (
        <p className="error">Не удалось прочитать итоги объекта.</p>
      ) : result ? (
        <>
          <p>
            Этажей: {result.floorCount} · помещений: {result.roomCount}
          </p>
          <dl className="quantity-list">
            <div>
              <dt>Пол</dt>
              <dd>{format(result.floorArea)} м²</dd>
            </div>
            <div>
              <dt>Потолок</dt>
              <dd>{format(result.ceilingArea)} м²</dd>
            </div>
            <div>
              <dt>Объём помещений</dt>
              <dd>{format(result.roomVolume)} м³</dd>
            </div>
            <div>
              <dt>Чистые поверхности стен</dt>
              <dd>{format(result.netWallArea)} м²</dd>
            </div>
            <div>
              <dt>Объём конструкций</dt>
              <dd>{format(result.constructionVolume)} м³</dd>
            </div>
          </dl>
          {!result.complete && (
            <p>Неполные итоги: суммируются только доступные значения.</p>
          )}
          <small>Обновляются после локального сохранения.</small>
        </>
      ) : (
        <p>Считаем…</p>
      )}
    </details>
  );
}
