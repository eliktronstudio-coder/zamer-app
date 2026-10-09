import { useStore } from "zustand";
import type { EditorStore } from "./store";
import { quantity, roomStatuses } from "./RoomProperties";
import { polygonArea } from "../geometry/primitives";
const names: Record<string, string> = {
  wall: "Стены",
  column: "Колонны",
  window: "Окна",
  door: "Двери",
  void: "Проёмы",
  beam: "Балки",
  stair: "Лестницы",
  ramp: "Пандусы",
  levelChange: "Перепады уровня",
};
export function CalculationPanel({ store }: { store: EditorStore }) {
  const state = useStore(store),
    { floor, topology } = state.calculation;
  return (
    <section className="calculation-panel" aria-label="Помещения и расчёты">
      <h2>Помещения и расчёты</h2>
      <p>
        Сохранённых помещений: {floor.roomCount} · замкнутых:{" "}
        {floor.closedRoomCount} · найдено контуров: {topology.candidates.length}
      </p>
      {(state.scene.rooms ?? []).map((room) => (
        <button
          className={state.selection === room.id ? "selected" : ""}
          key={room.id}
          onClick={() => {
            state.setTool("select");
            state.select(room.id);
          }}
          aria-label={`Выбрать помещение ${room.name || "без названия"}`}
        >
          {room.name || "Без названия"} · {roomStatuses[room.status]}
        </button>
      ))}
      {topology.candidates
        .filter(
          (face) =>
            !state.scene.rooms?.some(
              (r) => r.geometricallyClosed && r.sourceKey === face.sourceKey,
            ),
        )
        .map((face, i) => (
          <button
            key={face.sourceKey}
            onClick={() => {
              state.setTool("room");
              store.setState({ roomCandidate: face });
            }}
          >
            Добавить контур {i + 1} ·{" "}
            {quantity(
              polygonArea(face.boundary) -
                face.holes.reduce((s, h) => s + polygonArea(h), 0),
              "м²",
            )}
          </button>
        ))}
      {topology.problems.map((message) => (
        <p className="error" key={message}>
          {message}
        </p>
      ))}
      {floor.roomCount > 0 && (
        <>
          <h3>Учтённые помещения этажа</h3>
          <dl className="quantity-list floor-quantities">
            {(
              [
                ["Площадь по контурам", floor.contourArea, "м²"],
                ["Пол", floor.floorArea, "м²"],
                ["Потолок", floor.ceilingArea, "м²"],
                ["Объём помещений", floor.roomVolume, "м³"],
                ["Поверхности стен", floor.grossWallArea, "м²"],
                ["Чистые поверхности стен", floor.netWallArea, "м²"],
              ] as const
            ).map(([label, value, unit]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{quantity(value, unit)}</dd>
              </div>
            ))}
          </dl>
          {!floor.complete && (
            <p>
              Итоги неполные: учитываются только доступные расчёты. Проверьте
              незамкнутые и ещё не добавленные помещения.
            </p>
          )}
        </>
      )}
      <details>
        <summary>Конструкции и проёмы этажа</summary>
        <dl className="quantity-list">
          <div>
            <dt>Площадь проёмов, каждый один раз</dt>
            <dd>{quantity(floor.openingArea, "м²")}</dd>
          </div>
          <div>
            <dt>Объём стен без проёмов, каждый один раз</dt>
            <dd>{quantity(floor.wallVolume, "м³")}</dd>
          </div>
          <div>
            <dt>Сумма объёмов конструкций</dt>
            <dd>{quantity(floor.constructionVolume, "м³")}</dd>
          </div>
        </dl>
        <p>
          {Object.entries(floor.elementCounts)
            .map(([kind, count]) => `${names[kind] ?? kind}: ${count}`)
            .join(" · ")}
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Конструкция</th>
                <th>Объём</th>
                <th>Поверхность</th>
              </tr>
            </thead>
            <tbody>
              {floor.elements
                .filter((e) => e.kind !== "opening" && e.kind !== "levelChange")
                .map((e, i) => (
                  <tr key={e.id}>
                    <td>
                      <button
                        onClick={() => {
                          state.setTool("select");
                          state.select(e.id);
                        }}
                      >
                        {names[e.kind]} {i + 1}
                      </button>
                    </td>
                    <td>{quantity(e.volume, "м³")}</td>
                    <td>{quantity(e.surfaceArea, "м²")}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
      <details>
        <summary>Как считаются результаты</summary>
        <p>
          Площади и объём помещения считаются по контуру замера; толщина стен не
          сдвигает этот контур. Колонны вычитаются из пола, а колонны до потолка
          — из потолка. Объём помещения показывается по контуру без вычета
          конструкций.
        </p>
        <p>
          Проёмы вычитаются из поверхности каждой стороны стены. В общих итогах
          объём стены и площадь проёма считаются один раз. Глубина откосов —
          указанная в свойствах проёма или половина толщины стены.
        </p>
        <p>
          Объём лестницы — ступенчатое тело без плиты, пандуса — клин без
          основания. Поверхность колонны/балки включает все грани, лестницы —
          проступи и подступенки, пандуса — наклонную плоскость. Объёмы
          отдельных конструкций суммируются без вычета взаимных пересечений.
        </p>
      </details>
    </section>
  );
}
