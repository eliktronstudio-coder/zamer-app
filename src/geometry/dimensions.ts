import type { Dimension, Point, PointReference, Wall } from "../domain/model";
import { distance } from "./primitives";
import { interpolate } from "./vector";

export type ReferenceFailure = {
  ok: false;
  code: "missing-element" | "wrong-floor" | "duplicate-element";
  elementIds: string[];
};
export function resolveReference(
  reference: PointReference,
  walls: readonly Wall[],
  floorId: string,
): { ok: true; point: Point } | ReferenceFailure {
  const matches = walls.filter((w) => w.id === reference.elementId);
  if (matches.length !== 1)
    return {
      ok: false,
      code: matches.length ? "duplicate-element" : "missing-element",
      elementIds: [reference.elementId],
    };
  const wall = matches[0];
  if (wall.floorId !== floorId)
    return { ok: false, code: "wrong-floor", elementIds: [wall.id] };
  const point =
    reference.anchor === "center"
      ? interpolate(wall.start, wall.end, 0.5)
      : { ...wall[reference.anchor] };
  return { ok: true, point };
}
export function evaluateDimension(
  dimension: Dimension,
  walls: readonly Wall[],
): { ok: true; value: number; from: Point; to: Point } | ReferenceFailure {
  const from = resolveReference(dimension.from, walls, dimension.floorId);
  if (!from.ok) return from;
  const to = resolveReference(dimension.to, walls, dimension.floorId);
  if (!to.ok) return to;
  return {
    ok: true,
    value: distance(from.point, to.point),
    from: from.point,
    to: to.point,
  };
}
