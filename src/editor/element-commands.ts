import type { ConstructionElement, Point } from "../domain/model";
import type { GeometryScene } from "../geometry/constraints";
import { parseElement, openingProblems } from "../geometry/elements";
export type ConstructionTool =
  | "column"
  | "window"
  | "door"
  | "void"
  | "beam"
  | "stair"
  | "ramp"
  | "levelChange";
export const toolNames: Record<ConstructionTool, string> = {
  column: "Колонна",
  window: "Окно",
  door: "Дверь",
  void: "Проём",
  beam: "Ригель / балка",
  stair: "Лестница",
  ramp: "Пандус",
  levelChange: "Перепад уровня",
};
export function isConstructionTool(tool: string): tool is ConstructionTool {
  return Object.hasOwn(toolNames, tool);
}
export function defaultElement(
  tool: ConstructionTool,
  floorId: string,
  height: number,
): ConstructionElement {
  const base = { id: crypto.randomUUID(), floorId, roomIds: [], metadata: {} },
    position = { x: 0, y: 0 };
  switch (tool) {
    case "column":
      return {
        ...base,
        kind: "column",
        position,
        rotation: 0,
        section: { kind: "rectangle", width: 0.4, depth: 0.4 },
        height,
        material: "ЖБ",
      };
    case "window":
    case "door":
    case "void":
      return {
        ...base,
        kind: "opening",
        type: tool,
        wallId: crypto.randomUUID(),
        offset: 0,
        width: tool === "window" ? 1.2 : 0.9,
        height: tool === "window" ? 1.4 : 2.1,
        sill: tool === "window" ? 0.9 : 0,
        side: "left",
      };
    case "beam":
      return {
        ...base,
        kind: "beam",
        start: position,
        end: { x: 2, y: 0 },
        width: 0.3,
        height: 0.4,
        elevation: height,
        material: "ЖБ",
      };
    case "stair":
      return {
        ...base,
        kind: "stair",
        position,
        rotation: 0,
        width: 1,
        length: 3,
        rise: 1.5,
        steps: 10,
      };
    case "ramp":
      return {
        ...base,
        kind: "ramp",
        position,
        rotation: 0,
        width: 1.2,
        length: 4,
        rise: 0.3,
      };
    case "levelChange":
      return {
        ...base,
        kind: "levelChange",
        boundary: [position, { x: 1, y: 0 }],
        fromElevation: 0,
        toElevation: 0.15,
      };
  }
}
export function putElement(
  scene: GeometryScene,
  input: ConstructionElement,
): GeometryScene {
  const e = parseElement(input);
  if (e.kind === "opening") {
    const issues = openingProblems(e, scene.walls, scene.elements);
    if (issues.length) throw new Error(issues.join(". "));
  }
  if (
    [...scene.walls, ...scene.junctions, ...scene.dimensions].some(
      (w) => w.id === e.id,
    )
  )
    throw new Error("Идентификатор элемента занят");
  const existing = scene.elements?.find((item) => item.id === e.id);
  if (existing && existing.floorId !== e.floorId)
    throw new Error("Элемент относится к другому этажу");
  return {
    ...scene,
    elements: existing
      ? (scene.elements ?? []).map((item) => (item.id === e.id ? e : item))
      : [...(scene.elements ?? []), e],
  };
}
export function moveElement(
  scene: GeometryScene,
  id: string,
  delta: Point,
): GeometryScene {
  const e = scene.elements?.find((item) => item.id === id);
  if (!e) throw new Error("Элемент не найден");
  return putElement(scene, translate(e, delta, scene));
}
import { translateElement } from "../geometry/elements";
const translate = (e: ConstructionElement, p: Point, s: GeometryScene) =>
  translateElement(e, p, s.walls);
