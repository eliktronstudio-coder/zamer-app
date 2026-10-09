import type { Dimension, Junction, Wall, Point } from "../../src/domain/model";
import { distance } from "../../src/geometry/primitives";
import type {
  GeometryScene,
  GeometryCommandResult,
} from "../../src/geometry/constraints";
export const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const floorId = uuid(999);
export function wall(
  n: number,
  start: Point = { x: 0, y: 0 },
  end: Point = { x: 4.25, y: 0 },
  overrides: Partial<Wall> = {},
): Wall {
  return {
    id: uuid(n),
    floorId,
    kind: "wall",
    start,
    end,
    measuredLength: distance(start, end),
    thickness: 0.2,
    height: 2.7,
    roomIds: [],
    metadata: {},
    ...overrides,
  };
}
export function dimension(
  n: number,
  w: Wall,
  overrides: Partial<Dimension> = {},
): Dimension {
  return {
    id: uuid(n),
    floorId: w.floorId,
    kind: "dimension",
    roomIds: [],
    metadata: {},
    mode: "driving",
    from: { elementId: w.id, anchor: "start" },
    to: { elementId: w.id, anchor: "end" },
    offset: 0.4,
    inputValue: w.measuredLength,
    ...overrides,
  };
}
export function junction(n: number, a: Wall, b: Wall): Junction {
  return {
    id: uuid(n),
    floorId: a.floorId,
    endpoints: [
      { elementId: a.id, anchor: "end" },
      { elementId: b.id, anchor: "start" },
    ],
  };
}
export function scene(
  walls: Wall[],
  dimensions: Dimension[] = [],
  junctions: Junction[] = [],
): GeometryScene {
  return { walls, dimensions, junctions, elements: [], rooms: [] };
}
export function successful(result: GeometryCommandResult) {
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result;
}
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
