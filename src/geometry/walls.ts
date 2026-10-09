import { wallSchema, type Point, type Wall } from "../domain/model";
import { distance } from "./primitives";
import {
  add,
  assertPoint,
  assertPositive,
  multiply,
  unitDirection,
} from "./vector";
import { rotatePoint, translatePoint } from "./transforms";
import type { Segment } from "./segments";

export function orthogonalTarget(start: Point, target: Point): Point {
  assertPoint(start);
  assertPoint(target);
  return Math.abs(target.x - start.x) >= Math.abs(target.y - start.y)
    ? { x: target.x, y: start.y }
    : { x: start.x, y: target.y };
}
export function endpointAtLength(
  start: Point,
  toward: Point,
  length: number,
  orthogonal = false,
): Point {
  assertPositive(length, "Длина");
  const direction = unitDirection(
    start,
    orthogonal ? orthogonalTarget(start, toward) : toward,
  );
  return add(start, multiply(direction, length));
}
export function parseLengthInput(input: string): number {
  const match = input
    .trim()
    .match(/^\+?((?:\d+(?:[.,]\d+)?)|(?:[.,]\d+))\s*(?:м|m)?$/i);
  if (!match) throw new RangeError("Введите длину в метрах, например 4,257");
  const value = Number(match[1].replace(",", "."));
  assertPositive(value, "Длина");
  return value;
}
export interface CreateWallInput {
  id: string;
  floorId: string;
  start: Point;
  toward: Point;
  length: number;
  thickness: number;
  height: number;
  orthogonal?: boolean;
}
export function createMeasuredWall(input: CreateWallInput): Wall {
  return wallSchema.parse({
    id: input.id,
    floorId: input.floorId,
    kind: "wall",
    start: input.start,
    end: endpointAtLength(
      input.start,
      input.toward,
      input.length,
      input.orthogonal,
    ),
    measuredLength: input.length,
    thickness: input.thickness,
    height: input.height,
    roomIds: [],
    metadata: {},
  });
}
export function setWallLength(
  wall: Wall,
  length: number,
  fixed: "start" | "end" = "start",
): Wall {
  const moving = fixed === "start" ? "end" : "start";
  return wallSchema.parse({
    ...wall,
    [moving]: endpointAtLength(wall[fixed], wall[moving], length),
    measuredLength: length,
  });
}
export function translateWall(wall: Wall, offset: Point): Wall {
  return {
    ...wall,
    start: translatePoint(wall.start, offset),
    end: translatePoint(wall.end, offset),
  };
}
export function rotateWall(
  wall: Wall,
  angle: number,
  pivot: Point = wall.start,
): Wall {
  return {
    ...wall,
    start: rotatePoint(wall.start, angle, pivot),
    end: rotatePoint(wall.end, angle, pivot),
  };
}
export function wallEdges(wall: Wall): {
  axis: Segment;
  left: Segment;
  right: Segment;
} {
  assertPositive(wall.thickness, "Толщина");
  const direction = unitDirection(wall.start, wall.end);
  const normal = {
    x: (-direction.y * wall.thickness) / 2,
    y: (direction.x * wall.thickness) / 2,
  };
  return {
    axis: { start: { ...wall.start }, end: { ...wall.end } },
    left: { start: add(wall.start, normal), end: add(wall.end, normal) },
    right: {
      start: add(wall.start, multiply(normal, -1)),
      end: add(wall.end, multiply(normal, -1)),
    },
  };
}
export function lengthMatches(wall: Wall, value: number): boolean {
  // Include representational precision of coordinates, never display rounding.
  const tolerance = Math.max(
    1e-9,
    Number.EPSILON *
      8 *
      Math.max(
        1,
        Math.abs(wall.start.x),
        Math.abs(wall.start.y),
        Math.abs(wall.end.x),
        Math.abs(wall.end.y),
        value,
      ),
  );
  return Math.abs(distance(wall.start, wall.end) - value) <= tolerance;
}
