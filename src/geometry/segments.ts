import { orient2d } from "robust-predicates";
import type { Point } from "../domain/model";
import { GEOMETRY_EPSILON, distance } from "./primitives";
import {
  assertPoint,
  assertPositive,
  cross,
  dot,
  interpolate,
  subtract,
} from "./vector";

export interface Segment {
  start: Point;
  end: Point;
}
export type SegmentIntersection =
  | { kind: "none" }
  | { kind: "point"; point: Point }
  | { kind: "overlap"; start: Point; end: Point };

export function projectToLine(
  point: Point,
  segment: Segment,
): { point: Point; parameter: number } {
  assertPoint(point);
  assertPoint(segment.start);
  assertPoint(segment.end);
  const direction = subtract(segment.end, segment.start);
  const length = Math.hypot(direction.x, direction.y);
  if (length === 0) return { point: { ...segment.start }, parameter: 0 };
  assertPositive(length, "Длина отрезка");
  // Normalize before the dot product to avoid squaring a very large length.
  const unit = { x: direction.x / length, y: direction.y / length };
  const parameter = dot(subtract(point, segment.start), unit) / length;
  return {
    point: interpolate(segment.start, segment.end, parameter),
    parameter,
  };
}
export function nearestOnSegment(
  point: Point,
  segment: Segment,
): { point: Point; parameter: number; distance: number } {
  const projected = projectToLine(point, segment);
  const parameter = Math.max(0, Math.min(1, projected.parameter));
  const nearest = interpolate(segment.start, segment.end, parameter);
  return { point: nearest, parameter, distance: distance(point, nearest) };
}
export function pointOnSegment(
  point: Point,
  segment: Segment,
  tolerance = GEOMETRY_EPSILON,
): boolean {
  assertPositive(tolerance, "Допуск");
  return nearestOnSegment(point, segment).distance <= tolerance;
}
export function intersectSegments(
  a: Segment,
  b: Segment,
  tolerance = GEOMETRY_EPSILON,
): SegmentIntersection {
  assertPositive(tolerance, "Допуск");
  [a.start, a.end, b.start, b.end].forEach(assertPoint);
  const r = subtract(a.end, a.start),
    s = subtract(b.end, b.start);
  const lengthA = distance(a.start, a.end),
    lengthB = distance(b.start, b.end);
  if (lengthA === 0 && lengthB === 0)
    return distance(a.start, b.start) <= tolerance
      ? { kind: "point", point: interpolate(a.start, b.start, 0.5) }
      : { kind: "none" };
  if (lengthA === 0)
    return pointOnSegment(a.start, b, tolerance)
      ? { kind: "point", point: { ...a.start } }
      : { kind: "none" };
  if (lengthB === 0)
    return pointOnSegment(b.start, a, tolerance)
      ? { kind: "point", point: { ...b.start } }
      : { kind: "none" };
  const rUnit = { x: r.x / lengthA, y: r.y / lengthA };
  const q = subtract(b.start, a.start);
  // Adaptive predicates distinguish parallel and almost-parallel represented vectors.
  const determinant = -orient2d(0, 0, r.x, r.y, s.x, s.y);
  if (!Number.isFinite(determinant))
    throw new RangeError("Пересечение вне числового диапазона");
  if (determinant === 0) {
    if (Math.abs(cross(q, rUnit)) > tolerance) return { kind: "none" };
    const first = dot(q, rUnit),
      second = dot(subtract(b.end, a.start), rUnit);
    const lower = Math.max(0, Math.min(first, second));
    const upper = Math.min(lengthA, Math.max(first, second));
    if (upper < lower - tolerance) return { kind: "none" };
    if (upper - lower <= tolerance)
      return {
        kind: "point",
        point: interpolate(
          a.start,
          a.end,
          Math.max(0, Math.min(1, (lower + upper) / 2 / lengthA)),
        ),
      };
    const start = interpolate(a.start, a.end, lower / lengthA),
      end = interpolate(a.start, a.end, upper / lengthA);
    return start.x < end.x || (start.x === end.x && start.y <= end.y)
      ? { kind: "overlap", start, end }
      : { kind: "overlap", start: end, end: start };
  }
  const parameterA = -orient2d(0, 0, q.x, q.y, s.x, s.y) / determinant;
  const parameterB = -orient2d(0, 0, q.x, q.y, r.x, r.y) / determinant;
  const alongA = parameterA * lengthA,
    alongB = parameterB * lengthB;
  if (!Number.isFinite(alongA) || !Number.isFinite(alongB))
    throw new RangeError("Пересечение вне числового диапазона");
  if (
    alongA < -tolerance ||
    alongA > lengthA + tolerance ||
    alongB < -tolerance ||
    alongB > lengthB + tolerance
  )
    return { kind: "none" };
  const point = interpolate(
    a.start,
    a.end,
    Math.max(0, Math.min(1, alongA / lengthA)),
  );
  return pointOnSegment(point, b, tolerance)
    ? { kind: "point", point }
    : { kind: "none" };
}
