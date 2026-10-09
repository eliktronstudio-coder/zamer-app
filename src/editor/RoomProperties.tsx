import { useState } from "react";
import { useStore } from "zustand";
import type { Room } from "../domain/model";
import { polygonArea, perimeter } from "../geometry/primitives";
import type { EditorStore } from "./store";
import { parseLengthInput } from "../geometry/walls";
import type { RoomQuantities } from "../calculation/quantities";
export const roomStatuses: Record<Room["status"], string> = {
  notStarted: "Не начато",
  inProgress: "В работе",
  issues: "Есть нестыковки",
  completed: "Завершено",
  completedWithNotes: "Завершено с замечаниями",
};
export function quantity(value: number | null, unit: string): string {
  return value === null
    ? "Нет достоверного расчёта"
    : `${new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} ${unit}`;
}
export function RoomProperties({ store }: { store: EditorStore }) {
  const state = useStore(store),
    room = state.scene.rooms?.find((r) => r.id === state.selection);
  const [review, setReview] = useState(false);
  if (state.tool === "room")
    return (
      <section className="properties" data-testid="room-properties">
        <h2>{state.rebindRoomId ? "Новый контур помещения" : "Помещение"}</h2>
        {!state.roomCandidate ? (
          <p>
            Нажмите внутри замкнутого контура. Название и завершение работы
            задаются отдельно.
          </p>
        ) : (
          <>
            <p>
              Контур замкнут ·{" "}
              {quantity(
                polygonArea(state.roomCandidate.boundary) -
                  state.roomCandidate.holes.reduce(
                    (s, h) => s + polygonArea(h),
                    0,
                  ),
                "м²",
              )}{" "}
              ·{" "}
              {quantity(
                perimeter(state.roomCandidate.boundary) +
                  state.roomCandidate.holes.reduce(
                    (s, h) => s + perimeter(h),
                    0,
                  ),
                "м",
              )}
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                try {
                  const raw = String(data.get("height") ?? "").trim();
                  state.registerRoom(
                    String(data.get("name") ?? ""),
                    raw ? parseLengthInput(raw) : null,
                  );
                } catch (error) {
                  store.setState({
                    message:
                      error instanceof Error
                        ? error.message
                        : "Проверьте высоту",
                  });
                }
              }}
            >
              {!state.rebindRoomId && (
                <>
                  <label>
                    Название помещения
                    <input
                      name="name"
                      maxLength={80}
                      placeholder="Введите своё название"
                    />
                  </label>
                  <label>
                    Высота помещения, м
                    <input
                      name="height"
                      inputMode="decimal"
                      placeholder={`По умолчанию ${state.height}`}
                    />
                  </label>
                </>
              )}
              <button className="primary">
                {state.rebindRoomId
                  ? "Применить новый контур"
                  : "Добавить помещение"}
              </button>
            </form>
          </>
        )}
      </section>
    );
  if (!room) return null;
  const q = state.calculation.rooms.find((q) => q.roomId === room.id)!;
  return (
    <section
      className="properties room-properties"
      data-testid="room-properties"
    >
      <h2>{room.name || "Помещение без названия"}</h2>
      <p data-testid="room-closure">
        {room.geometricallyClosed
          ? "Геометрически замкнуто"
          : "Контур не замкнут"}
      </p>
      <p data-testid="room-status">{roomStatuses[room.status]}</p>
      <form
        key={`${room.id}:${room.name}:${room.height}:${room.status}`}
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const data = new FormData(event.currentTarget),
              raw = String(data.get("height") ?? "").trim();
            state.updateRoom({
              ...room,
              name: String(data.get("name")),
              height: raw ? parseLengthInput(raw) : null,
              status: String(data.get("status")) as Room["status"],
            });
            setReview(false);
          } catch (error) {
            store.setState({
              message:
                error instanceof Error ? error.message : "Проверьте параметры",
            });
          }
        }}
      >
        <label>
          Название помещения
          <input name="name" defaultValue={room.name} maxLength={80} />
        </label>
        <label>
          Высота помещения, м
          <input
            name="height"
            inputMode="decimal"
            defaultValue={room.height ?? ""}
            placeholder={`По умолчанию ${q.height}`}
          />
        </label>
        <label>
          Работа над помещением
          <select
            name="status"
            defaultValue={
              room.status === "notStarted" ? "notStarted" : "inProgress"
            }
          >
            <option value="notStarted">Не начато</option>
            <option value="inProgress">В работе</option>
            <option value="issues">Есть нестыковки</option>
          </select>
        </label>
        <button className="primary">Сохранить помещение</button>
      </form>
      <RoomMeasurements quantities={q} />
      {q.problems.length > 0 && (
        <div className="room-warnings">
          <strong>Неполные данные</strong>
          <ul>
            {q.problems.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      <button
        onClick={() => {
          if (!state.finishRoom(room.id)) setReview(true);
          else setReview(false);
        }}
      >
        Завершить помещение
      </button>
      {review && (
        <div role="group" aria-label="Проверка завершения">
          <p>
            Есть замечания к помещению. Вы можете продолжить работу или
            завершить с замечаниями.
          </p>
          <button onClick={() => setReview(false)}>Исправить сейчас</button>
          <button
            onClick={() => {
              state.finishRoom(room.id, true);
              setReview(false);
            }}
          >
            Завершить с замечаниями
          </button>
        </div>
      )}
      <button onClick={() => state.rebindRoom(room.id)}>
        Перепривязать контур
      </button>
      <button className="danger" onClick={state.remove}>
        Удалить помещение
      </button>
      {q.walls.length > 0 && (
        <details>
          <summary>Поверхности стен ({q.walls.length})</summary>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Стена</th>
                  <th>Длина</th>
                  <th>Площадь</th>
                  <th>Проёмы</th>
                  <th>Чистая</th>
                </tr>
              </thead>
              <tbody>
                {q.walls.map((w, i) => (
                  <tr key={`${w.wallId}:${i}`}>
                    <td>
                      <button onClick={() => state.select(w.wallId)}>
                        Стена {i + 1}
                      </button>
                    </td>
                    <td>{quantity(w.length, "м")}</td>
                    <td>{quantity(w.grossArea, "м²")}</td>
                    <td>{quantity(w.openingsArea, "м²")}</td>
                    <td>{quantity(w.netArea, "м²")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
export function RoomMeasurements({
  quantities: q,
}: {
  quantities: RoomQuantities;
}) {
  return (
    <dl className="quantity-list">
      {(
        [
          ["Площадь по контуру", q.contourArea, "м²"],
          ["Площадь пола", q.floorArea, "м²"],
          ["Площадь потолка", q.ceilingArea, "м²"],
          ["Периметр", q.perimeter, "м"],
          ["Объём помещения", q.volume, "м³"],
          ["Площадь стен", q.grossWallArea, "м²"],
          ["Площадь окон", q.windowArea, "м²"],
          ["Площадь дверей", q.doorArea, "м²"],
          ["Площадь прочих проёмов", q.voidArea, "м²"],
          ["Чистая площадь стен", q.netWallArea, "м²"],
          ["Длина откосов", q.revealLength, "м"],
          ["Площадь откосов", q.revealArea, "м²"],
        ] as const
      ).map(([label, value, unit]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd data-quantity={label}>{quantity(value, unit)}</dd>
        </div>
      ))}
    </dl>
  );
}
