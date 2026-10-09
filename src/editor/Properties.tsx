import { RoomProperties } from "./RoomProperties";
import { ConstructionProperties } from "./ConstructionProperties";
import { isConstructionTool } from "./element-commands";
import { useState, type FormEvent } from "react";
import { useStore } from "zustand";
import type { EditorStore } from "./store";
import { parseLengthInput } from "../geometry/walls";
import { distance } from "../geometry/primitives";
import { applyDrivingDimension } from "../geometry/constraints";
import { evaluateDimension } from "../geometry/dimensions";
import { updateWallProperties } from "./commands";
import { formatLength } from "../app/format";
export function Properties({ store }: { store: EditorStore }) {
  const state = useStore(store),
    wall = state.scene.walls.find((w) => w.id === state.selection),
    dimension = state.scene.dimensions.find((d) => d.id === state.selection);
  const [edit, setEdit] = useState<{
    id: string;
    length: string;
    thickness: string;
    height: string;
  } | null>(null);
  function error(error: unknown) {
    store.setState({
      message:
        error instanceof Error ? error.message : "Проверьте параметры элемента",
    });
  }
  if (
    state.tool === "room" ||
    ((state.tool === "select" || state.tool === "hand") &&
      state.scene.rooms?.some((r) => r.id === state.selection))
  )
    return <RoomProperties key={state.selection ?? "draft"} store={store} />;
  if (
    isConstructionTool(state.tool) ||
    ((state.tool === "select" || state.tool === "hand") &&
      state.scene.elements?.some((e) => e.id === state.selection))
  )
    return <ConstructionProperties store={store} />;
  if (state.tool === "wall")
    return (
      <section className="properties">
        <h2>Построение стены</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (state.start && state.pointer)
              state.place(state.pointer, state.scale);
          }}
        >
          <label>
            Длина стены, м
            <input
              data-testid="construction-length"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (!event.repeat && state.start && state.pointer)
                    state.place(state.pointer, state.scale);
                }
              }}
              inputMode="decimal"
              value={state.lengthInput}
              onChange={(event) =>
                store.setState({ lengthInput: event.target.value })
              }
              placeholder="Например, 4,257"
            />
          </label>
          <p className="muted">
            {state.start
              ? "Enter завершит стену. Следующая начнётся из её конца."
              : "Сначала укажите начальную точку на плане."}
          </p>
          {state.start && (
            <div
              className="directions"
              role="group"
              aria-label="Направление стены"
            >
              {(
                [
                  ["Вправо", 1, 0, "→"],
                  ["Вниз", 0, 1, "↓"],
                  ["Влево", -1, 0, "←"],
                  ["Вверх", 0, -1, "↑"],
                ] as const
              ).map(([label, x, y, icon]) => (
                <button
                  type="button"
                  key={label}
                  aria-label={label}
                  onClick={() =>
                    state.setPointer({
                      x: state.start!.point.x + x,
                      y: state.start!.point.y + y,
                    })
                  }
                >
                  {icon}
                </button>
              ))}
            </div>
          )}
          <label>
            Толщина новых стен, м
            <input
              inputMode="decimal"
              defaultValue={state.thickness}
              key={`thickness${state.thickness}`}
              onBlur={(event) => {
                try {
                  store.setState({
                    thickness: parseLengthInput(event.target.value),
                  });
                } catch (e) {
                  error(e);
                  event.target.value = String(state.thickness);
                }
              }}
            />
          </label>
          <label>
            Высота новых стен, м
            <input
              inputMode="decimal"
              defaultValue={state.height}
              key={`height${state.height}`}
              onBlur={(event) => {
                try {
                  store.setState({
                    height: parseLengthInput(event.target.value),
                  });
                } catch (e) {
                  error(e);
                  event.target.value = String(state.height);
                }
              }}
            />
          </label>
          <button type="button" disabled={!state.start} onClick={state.cancel}>
            Завершить цепочку
          </button>
        </form>
      </section>
    );
  if (wall) {
    const values =
      edit?.id === wall.id
        ? edit
        : {
            id: wall.id,
            length: String(
              wall.measuredLength ?? distance(wall.start, wall.end),
            ),
            thickness: String(wall.thickness),
            height: String(wall.height),
          };
    function submit(event: FormEvent) {
      event.preventDefault();
      try {
        const length = parseLengthInput(values.length),
          thickness = parseLengthInput(values.thickness),
          height = parseLengthInput(values.height);
        const current = store.getState();
        const result = updateWallProperties(current.scene, wall!.id, {
          length,
          thickness,
          height,
        });
        if (!result.ok) {
          current.apply(result);
          return;
        }
        current.commit(result.scene);
        setEdit(null);
      } catch (e) {
        error(e);
      }
    }
    return (
      <section className="properties">
        <h2>Свойства стены</h2>
        <form onSubmit={submit}>
          <label>
            Длина выбранной стены, м
            <input
              inputMode="decimal"
              value={values.length}
              onChange={(event) =>
                setEdit({ ...values, length: event.target.value })
              }
            />
          </label>
          <label>
            Толщина стены, м
            <input
              inputMode="decimal"
              value={values.thickness}
              onChange={(event) =>
                setEdit({ ...values, thickness: event.target.value })
              }
            />
          </label>
          <label>
            Высота стены, м
            <input
              inputMode="decimal"
              value={values.height}
              onChange={(event) =>
                setEdit({ ...values, height: event.target.value })
              }
            />
          </label>
          <button className="primary">Применить параметры</button>
        </form>
        <p className="muted">
          Точный размер имеет приоритет. Связанные измеренные стены не
          растягиваются молча.
        </p>
        {(state.scene.elements ?? []).some(
          (e) => e.kind === "opening" && e.wallId === wall.id,
        ) && (
          <p className="muted">
            Удаление стены также удалит её проёмы. Undo восстановит их вместе.
          </p>
        )}
        <button
          onClick={state.detach}
          disabled={
            !state.scene.junctions.some((j) =>
              j.endpoints.some((r) => r.elementId === wall.id),
            )
          }
        >
          Разъединить стену
        </button>
        <button className="danger" onClick={state.remove}>
          Удалить стену
        </button>
      </section>
    );
  }
  if (dimension) {
    const evaluated = evaluateDimension(dimension, state.scene.walls);
    return (
      <section className="properties">
        <h2>
          {dimension.mode === "driving"
            ? "Управляющий размер"
            : "Справочный размер"}
        </h2>
        <p>
          {evaluated.ok
            ? formatLength(evaluated.value)
            : "Размер потерял связь"}
        </p>
        {dimension.mode === "driving" && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              try {
                const data = new FormData(event.currentTarget);
                state.apply(
                  applyDrivingDimension(
                    state.scene,
                    dimension.id,
                    parseLengthInput(String(data.get("length"))),
                  ),
                );
              } catch (e) {
                error(e);
              }
            }}
          >
            <label>
              Значение размера, м
              <input
                name="length"
                inputMode="decimal"
                key={`${dimension.id}${evaluated.ok ? evaluated.value : ""}`}
                defaultValue={
                  dimension.inputValue ?? (evaluated.ok ? evaluated.value : "")
                }
              />
            </label>
            <button className="primary">Изменить длину</button>
          </form>
        )}
        <p className="muted">
          {dimension.mode === "reference"
            ? "Обновляется вместе со связанной геометрией."
            : "Изменение значения меняет длину связанной стены."}
        </p>
        <button onClick={state.remove}>Удалить размер</button>
      </section>
    );
  }
  return (
    <section className="properties">
      <h2>Свойства элемента</h2>
      <p className="muted">
        Выберите стену или размер на плане. Здесь можно изменить точные
        значения.
      </p>
      <p className="muted">
        Стены: {state.scene.walls.length}
        <br />
        Размеры: {state.scene.dimensions.length}
      </p>
    </section>
  );
}
