import type { Point } from "../domain/model";
import type { Segment } from "./segments";
import { add, assertPoint, checkedPoint, subtract } from "./vector";

export interface Transform2D {
  // Linear matrix [a c; b d] followed by translation. Coordinates are meters.
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}
export const IDENTITY_TRANSFORM: Readonly<Transform2D> = Object.freeze({
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  tx: 0,
  ty: 0,
});
export function applyTransform(point: Point, transform: Transform2D): Point {
  assertPoint(point);
  if (!Object.values(transform).every(Number.isFinite))
    throw new RangeError("Преобразование должно быть конечным");
  return checkedPoint(
    transform.a * point.x + transform.c * point.y + transform.tx,
    transform.b * point.x + transform.d * point.y + transform.ty,
  );
}
// composeTransforms(after,before) applies before first.
export function composeTransforms(
  after: Transform2D,
  before: Transform2D,
): Transform2D {
  if (
    ![...Object.values(after), ...Object.values(before)].every(Number.isFinite)
  )
    throw new RangeError("Преобразование должно быть конечным");
  const result = {
    a: after.a * before.a + after.c * before.b,
    b: after.b * before.a + after.d * before.b,
    c: after.a * before.c + after.c * before.d,
    d: after.b * before.c + after.d * before.d,
    tx: after.a * before.tx + after.c * before.ty + after.tx,
    ty: after.b * before.tx + after.d * before.ty + after.ty,
  };
  if (!Object.values(result).every(Number.isFinite))
    throw new RangeError("Переполнение преобразования");
  return result;
}
export function translationTransform(offset: Point): Transform2D {
  assertPoint(offset);
  return { ...IDENTITY_TRANSFORM, tx: offset.x, ty: offset.y };
}
export function rotationTransform(
  angle: number,
  pivot: Point = { x: 0, y: 0 },
): Transform2D {
  assertPoint(pivot);
  if (!Number.isFinite(angle))
    throw new RangeError("Угол должен быть конечным");
  const c = Math.cos(angle),
    s = Math.sin(angle);
  return composeTransforms(
    translationTransform(pivot),
    composeTransforms(
      { a: c, b: s, c: -s, d: c, tx: 0, ty: 0 },
      translationTransform({ x: -pivot.x, y: -pivot.y }),
    ),
  );
}
export function transformSegment(
  segment: Segment,
  transform: Transform2D,
): Segment {
  return {
    start: applyTransform(segment.start, transform),
    end: applyTransform(segment.end, transform),
  };
}
export function translatePoint(point: Point, offset: Point): Point {
  assertPoint(point);
  assertPoint(offset);
  return add(point, offset);
}
// Pivot-relative arithmetic preserves small geometry far from the origin.
export function rotatePoint(
  point: Point,
  angle: number,
  pivot: Point = { x: 0, y: 0 },
): Point {
  assertPoint(point);
  assertPoint(pivot);
  if (!Number.isFinite(angle))
    throw new RangeError("Угол должен быть конечным");
  const p = subtract(point, pivot),
    c = Math.cos(angle),
    s = Math.sin(angle);
  return add(pivot, checkedPoint(p.x * c - p.y * s, p.x * s + p.y * c));
}

export function invertTransform(transform: Transform2D): Transform2D {
  if (!Object.values(transform).every(Number.isFinite))
    throw new RangeError("Преобразование должно быть конечным");
  const determinant = transform.a * transform.d - transform.b * transform.c;
  if (determinant === 0 || !Number.isFinite(determinant))
    throw new RangeError("Преобразование необратимо");
  const a = transform.d / determinant,
    b = -transform.b / determinant,
    c = -transform.c / determinant,
    d = transform.a / determinant;
  const inverse = {
    a,
    b,
    c,
    d,
    tx: -(a * transform.tx + c * transform.ty),
    ty: -(b * transform.tx + d * transform.ty),
  };
  if (!Object.values(inverse).every(Number.isFinite))
    throw new RangeError("Обратное преобразование вне числового диапазона");
  return inverse;
}
