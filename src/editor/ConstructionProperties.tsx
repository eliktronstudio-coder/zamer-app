import { useState, type FormEvent } from "react";
import { useStore } from "zustand";
import type {
  ColumnSection,
  ConstructionElement,
  Point,
} from "../domain/model";
import { parseElement, openingProblems } from "../geometry/elements";
import { distance } from "../geometry/primitives";
import type { EditorStore } from "./store";
import { isConstructionTool, toolNames } from "./element-commands";

export function numberInput(value: FormDataEntryValue | null): number {
  const raw = String(value ?? "")
    .trim()
    .replace(",", ".");
  if (
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) ||
    !Number.isFinite(Number(raw))
  )
    throw new Error("Введите число с точкой или запятой");
  return Number(raw);
}
function pointsText(points: Point[]) {
  return points.map((p) => `${p.x}; ${p.y}`).join("\n");
}
function parsePoints(value: FormDataEntryValue | null): Point[] {
  return String(value ?? "")
    .trim()
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const pair = line.split(";");
      if (pair.length !== 2)
        throw new Error("Точка контура: X; Y, по одной точке в строке");
      return { x: numberInput(pair[0]), y: numberInput(pair[1]) };
    });
}
function Numeric({
  name,
  label,
  value,
}: {
  name: string;
  label: string;
  value: number;
}) {
  return (
    <label>
      {label}
      <input name={name} inputMode="decimal" defaultValue={value} />
    </label>
  );
}
const shapes = [
  ["circle", "Круглая"],
  ["ellipse", "Эллиптическая"],
  ["square", "Квадратная"],
  ["rectangle", "Прямоугольная"],
  ["L", "Г-образная"],
  ["T", "Т-образная"],
  ["cross", "Крестообразная"],
  ["H", "Двутавровая / H"],
  ["U", "Швеллерная / U"],
  ["box", "Коробчатая"],
  ["polygon", "Многоугольная"],
  ["custom", "Пользовательский контур"],
  ["composite", "Составная"],
] as const;
function shapeOf(section: ColumnSection): string {
  return section.kind === "profile"
    ? section.profile
    : section.kind === "rectangle" && section.width === section.depth
      ? "square"
      : section.kind;
}
function initialSection(shape: string): ColumnSection {
  if (shape === "circle") return { kind: "circle", diameter: 0.4 };
  if (shape === "ellipse" || shape === "rectangle" || shape === "square")
    return {
      kind: shape === "ellipse" ? "ellipse" : "rectangle",
      width: 0.4,
      depth: shape === "rectangle" ? 0.6 : 0.4,
    };
  if (shape === "polygon" || shape === "custom")
    return {
      kind: "polygon",
      vertices: [
        { x: -0.2, y: -0.2 },
        { x: 0.2, y: -0.2 },
        { x: 0.2, y: 0.2 },
        { x: -0.2, y: 0.2 },
      ],
    };
  if (shape === "composite")
    return {
      kind: "composite",
      parts: [
        {
          section: { kind: "rectangle", width: 0.4, depth: 0.4 },
          position: { x: 0, y: 0 },
          rotation: 0,
        },
        {
          section: { kind: "circle", diameter: 0.3 },
          position: { x: 0.35, y: 0 },
          rotation: 0,
        },
      ],
    };
  return {
    kind: "profile",
    profile: shape as "L" | "T" | "H" | "U" | "cross" | "box",
    width: 0.4,
    depth: 0.6,
    web: 0.08,
    flange: 0.08,
  };
}
function SectionFields({
  section,
  prefix = "section",
  nested = false,
}: {
  section: ColumnSection;
  prefix?: string;
  nested?: boolean;
}) {
  const [choice, setChoice] = useState(shapeOf(section));
  const [current, setCurrent] = useState(section);
  const [partsError, setPartsError] = useState("");
  function editParts(button: HTMLButtonElement, index?: number) {
    try {
      const actual = readSection(new FormData(button.form!), prefix);
      if (actual.kind !== "composite") return;
      const parts =
        index === undefined
          ? [
              ...actual.parts,
              {
                section: { kind: "rectangle" as const, width: 0.3, depth: 0.3 },
                position: { x: 0, y: 0 },
                rotation: 0,
              },
            ]
          : actual.parts.filter((_, i) => i !== index);
      setCurrent({ ...actual, parts });
      setPartsError("");
    } catch (error) {
      setPartsError(
        error instanceof Error ? error.message : "Проверьте размеры частей",
      );
    }
  }
  return (
    <fieldset className="section-fields">
      <legend>{nested ? "Сечение части" : "Сечение колонны"}</legend>
      <label>
        Форма сечения
        <select
          name={`${prefix}.shape`}
          value={choice}
          onChange={(event) => {
            setChoice(event.target.value);
            setCurrent(initialSection(event.target.value));
          }}
        >
          {shapes
            .filter(([id]) => !nested || id !== "composite")
            .map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
        </select>
      </label>
      <div key={choice}>
        {current.kind === "circle" && (
          <Numeric
            name={`${prefix}.diameter`}
            label="Диаметр, м"
            value={current.diameter}
          />
        )}
        {(current.kind === "ellipse" ||
          current.kind === "rectangle" ||
          current.kind === "profile") && (
          <>
            <Numeric
              name={`${prefix}.width`}
              label="Ширина сечения, м"
              value={current.width}
            />
            {choice !== "square" && (
              <Numeric
                name={`${prefix}.depth`}
                label="Глубина сечения, м"
                value={current.depth}
              />
            )}
            {current.kind === "profile" && (
              <>
                <Numeric
                  name={`${prefix}.web`}
                  label="Толщина стенки, м"
                  value={current.web}
                />
                <Numeric
                  name={`${prefix}.flange`}
                  label="Толщина полки, м"
                  value={current.flange}
                />
              </>
            )}
          </>
        )}
        {current.kind === "polygon" && (
          <label>
            Точки сечения, м
            <textarea
              name={`${prefix}.vertices`}
              rows={5}
              defaultValue={pointsText(current.vertices)}
            />
            <span className="muted">
              X; Y — по одной точке в строке, относительно центра колонны.
            </span>
          </label>
        )}
        {current.kind === "composite" && (
          <>
            <input
              type="hidden"
              name={`${prefix}.count`}
              value={current.parts.length}
            />
            {current.parts.map((part, i) => (
              <fieldset key={`${i}:${JSON.stringify(part)}`}>
                <legend>Часть {i + 1}</legend>
                <SectionFields
                  section={part.section}
                  prefix={`${prefix}.${i}`}
                  nested
                />
                <Numeric
                  name={`${prefix}.${i}.x`}
                  label="Смещение X, м"
                  value={part.position.x}
                />
                <Numeric
                  name={`${prefix}.${i}.y`}
                  label="Смещение Y, м"
                  value={part.position.y}
                />
                <Numeric
                  name={`${prefix}.${i}.rotation`}
                  label="Поворот части, °"
                  value={part.rotation}
                />
                <button
                  type="button"
                  disabled={current.parts.length <= 1}
                  onClick={(event) => editParts(event.currentTarget, i)}
                >
                  Удалить часть
                </button>
              </fieldset>
            ))}
            <button
              type="button"
              disabled={current.parts.length >= 20}
              onClick={(event) => editParts(event.currentTarget)}
            >
              Добавить часть
            </button>
          </>
        )}
      </div>
      {partsError && (
        <p className="error" role="alert">
          {partsError}
        </p>
      )}
    </fieldset>
  );
}
function readSection(data: FormData, prefix = "section"): ColumnSection {
  const shape = String(data.get(`${prefix}.shape`)),
    n = (key: string) => numberInput(data.get(`${prefix}.${key}`));
  if (shape === "circle") return { kind: "circle", diameter: n("diameter") };
  if (shape === "ellipse" || shape === "rectangle" || shape === "square")
    return {
      kind: shape === "ellipse" ? "ellipse" : "rectangle",
      width: n("width"),
      depth: shape === "square" ? n("width") : n("depth"),
    };
  if (shape === "polygon" || shape === "custom")
    return {
      kind: "polygon",
      vertices: parsePoints(data.get(`${prefix}.vertices`)),
    };
  if (shape === "composite")
    return {
      kind: "composite",
      parts: Array.from({ length: n("count") }, (_, i) => ({
        section: readSection(data, `${prefix}.${i}`),
        position: { x: n(`${i}.x`), y: n(`${i}.y`) },
        rotation: n(`${i}.rotation`),
      })),
    };
  return {
    kind: "profile",
    profile: shape as "L" | "T" | "H" | "U" | "cross" | "box",
    width: n("width"),
    depth: n("depth"),
    web: n("web"),
    flange: n("flange"),
  };
}
export function ConstructionProperties({ store }: { store: EditorStore }) {
  const state = useStore(store),
    placing = isConstructionTool(state.tool),
    selected = state.scene.elements?.find((e) => e.id === state.selection),
    element = placing ? state.elementDraft : selected;
  if (!element) return null;
  return (
    <ElementForm
      key={`${placing ? state.tool : element.id}:${JSON.stringify(element)}`}
      element={element}
      placing={placing}
      store={store}
    />
  );
}
function ElementForm({
  element: e,
  placing,
  store,
}: {
  element: ConstructionElement;
  placing: boolean;
  store: EditorStore;
}) {
  const state = useStore(store);
  const title = e.kind === "opening" ? toolNames[e.type] : toolNames[e.kind];
  const n = (data: FormData, name: string) => numberInput(data.get(name));
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const data = new FormData(event.currentTarget);
      let next: ConstructionElement;
      if (e.kind === "column")
        next = {
          ...e,
          section: readSection(data),
          height: n(data, "height"),
          rotation: n(data, "rotation"),
          material: String(data.get("material")),
          position: placing ? e.position : { x: n(data, "x"), y: n(data, "y") },
        };
      else if (e.kind === "opening")
        next = {
          ...e,
          width: n(data, "width"),
          height: n(data, "height"),
          sill: n(data, "sill"),
          offset: placing ? e.offset : n(data, "offset"),
          side: String(data.get("side")) as "left" | "right",
          revealDepth: n(data, "revealDepth"),
        };
      else if (e.kind === "beam") {
        const length = n(data, "length"),
          angle = (n(data, "rotation") * Math.PI) / 180,
          start = placing ? e.start : { x: n(data, "x"), y: n(data, "y") };
        if (length <= 0)
          throw new Error("Длина балки должна быть положительной");
        next = {
          ...e,
          start,
          end: {
            x: start.x + Math.cos(angle) * length,
            y: start.y + Math.sin(angle) * length,
          },
          width: n(data, "width"),
          height: n(data, "height"),
          elevation: n(data, "elevation"),
          material: String(data.get("material")),
        };
      } else if (e.kind === "levelChange")
        next = {
          ...e,
          boundary: placing ? e.boundary : parsePoints(data.get("boundary")),
          fromElevation: n(data, "fromElevation"),
          toElevation: n(data, "toElevation"),
        };
      else
        next = {
          ...e,
          position: placing ? e.position : { x: n(data, "x"), y: n(data, "y") },
          rotation: n(data, "rotation"),
          width: n(data, "width"),
          length: n(data, "length"),
          rise: n(data, "rise"),
          ...(e.kind === "stair" ? { steps: n(data, "steps") } : {}),
        };
      next = parseElement(next);
      if (placing)
        store.setState({
          elementDraft: next,
          draftDirty: false,
          message: "Параметры приняты. Укажите положение на плане.",
        });
      else store.getState().updateElement(next);
    } catch (error) {
      store.setState({
        message: error instanceof Error ? error.message : "Проверьте параметры",
      });
    }
  }
  return (
    <section className="properties construction-properties">
      <h2>
        {placing ? "Размещение: " : "Свойства: "}
        {title}
      </h2>
      {placing && (
        <p className="muted">
          {e.kind === "opening"
            ? "Задайте параметры, затем нажмите на стену в центре проёма."
            : e.kind === "beam"
              ? "Задайте длину, укажите начало и направление двумя нажатиями на план."
              : e.kind === "levelChange"
                ? "Укажите две точки для линии или три и более для области, затем завершите контур."
                : "Задайте размеры и направление, затем нажмите на план для размещения."}
        </p>
      )}
      <form
        onSubmit={submit}
        onChange={() => {
          if (placing) store.setState({ draftDirty: true });
        }}
      >
        {!placing && "position" in e && (
          <>
            <Numeric name="x" label="Положение X, м" value={e.position.x} />
            <Numeric name="y" label="Положение Y, м" value={e.position.y} />
          </>
        )}
        {e.kind === "column" && <SectionFields section={e.section} />}
        {e.kind === "opening" && (
          <>
            <Numeric name="width" label="Ширина проёма, м" value={e.width} />
            <Numeric name="height" label="Высота проёма, м" value={e.height} />
            <Numeric name="sill" label="Отметка от пола, м" value={e.sill} />
            {!placing && (
              <Numeric
                name="offset"
                label="Отступ от начала стены, м"
                value={e.offset}
              />
            )}
            <Numeric
              name="revealDepth"
              label="Глубина откосов, м"
              value={
                e.revealDepth ??
                (state.scene.walls.find((w) => w.id === e.wallId)?.thickness ??
                  0.2) / 2
              }
            />
            <label>
              Сторона / открывание
              <select name="side" defaultValue={e.side}>
                <option value="left">Слева</option>
                <option value="right">Справа</option>
              </select>
            </label>
          </>
        )}
        {e.kind === "column" && (
          <Numeric name="height" label="Высота колонны, м" value={e.height} />
        )}
        {(e.kind === "stair" || e.kind === "ramp" || e.kind === "beam") && (
          <>
            <Numeric
              name="width"
              label="Ширина конструкции, м"
              value={e.width}
            />
            <Numeric
              name="length"
              label="Длина конструкции, м"
              value={e.kind === "beam" ? distance(e.start, e.end) : e.length}
            />
          </>
        )}
        {e.kind === "beam" && (
          <>
            {!placing && (
              <>
                <Numeric name="x" label="Начало X, м" value={e.start.x} />
                <Numeric name="y" label="Начало Y, м" value={e.start.y} />
              </>
            )}
            <Numeric name="height" label="Высота балки, м" value={e.height} />
            <Numeric
              name="elevation"
              label="Отметка балки, м"
              value={e.elevation}
            />
            <Numeric
              name="rotation"
              label="Направление, °"
              value={
                (Math.atan2(e.end.y - e.start.y, e.end.x - e.start.x) * 180) /
                Math.PI
              }
            />
          </>
        )}
        {"rotation" in e && (
          <Numeric name="rotation" label="Направление, °" value={e.rotation} />
        )}
        {(e.kind === "stair" || e.kind === "ramp") && (
          <Numeric name="rise" label="Перепад высоты, м" value={e.rise} />
        )}
        {e.kind === "stair" && (
          <Numeric name="steps" label="Количество ступеней" value={e.steps} />
        )}
        {e.kind === "ramp" && (
          <p>Уклон: {((e.rise / e.length) * 100).toFixed(2)}%</p>
        )}
        {e.kind === "levelChange" && (
          <>
            <Numeric
              name="fromElevation"
              label="Исходная отметка, м"
              value={e.fromElevation}
            />
            <Numeric
              name="toElevation"
              label="Конечная отметка, м"
              value={e.toElevation}
            />
            {!placing && (
              <label>
                Точки границы, м
                <textarea
                  name="boundary"
                  rows={5}
                  defaultValue={pointsText(e.boundary)}
                />
                <span className="muted">X; Y, по одной точке в строке.</span>
              </label>
            )}
          </>
        )}
        {"material" in e && (
          <label>
            Материал
            <select name="material" defaultValue={e.material}>
              {[
                ...new Set([
                  "ЖБ",
                  "Металл",
                  "Кирпич",
                  "Дерево",
                  "Другое",
                  e.material,
                ]),
              ].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
        )}
        <button className="primary">
          {placing ? "Использовать параметры" : "Применить параметры элемента"}
        </button>
      </form>
      {placing && e.kind === "levelChange" && (
        <button
          disabled={state.constructionPoints.length < 2}
          onClick={state.finishBoundary}
        >
          Завершить границу ({state.constructionPoints.length})
        </button>
      )}
      {e.kind === "opening" &&
        !placing &&
        openingProblems(e, state.scene.walls, state.scene.elements).map(
          (message) => (
            <p className="error" key={message}>
              {message}. Измените параметры проёма или стены.
            </p>
          ),
        )}
      {!placing && (
        <button className="danger" onClick={state.remove}>
          Удалить элемент
        </button>
      )}
    </section>
  );
}
