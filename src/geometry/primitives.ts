import type { Point } from "../domain/model";
import { assertPoint } from "./vector";
export const GEOMETRY_EPSILON = 1e-9;
export function distance(a: Point, b: Point): number {
  assertPoint(a);
  assertPoint(b);
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (!Number.isFinite(length))
    throw new RangeError("Расстояние вне числового диапазона");
  return length;
}
// No rounding here. Rounding belongs to the presentation layer.
export function polygonArea(points: readonly Point[]): number {
  points.forEach(assertPoint);
  if (points.length < 3) return 0;
  const origin = points[0];
  let sum = 0,
    compensation = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i],
      q = points[(i + 1) % points.length];
    const term =
      (p.x - origin.x) * (q.y - origin.y) - (q.x - origin.x) * (p.y - origin.y);
    const adjusted = term - compensation,
      next = sum + adjusted;
    compensation = next - sum - adjusted;
    sum = next;
  }
  if (!Number.isFinite(sum))
    throw new RangeError("Площадь вне числового диапазона");
  return Math.abs(sum) / 2;
}
export function perimeter(points: readonly Point[]): number {
  points.forEach(assertPoint);
  const result =
    points.length < 2
      ? 0
      : points.reduce(
          (sum, p, i) => sum + distance(p, points[(i + 1) % points.length]),
          0,
        );
  if (!Number.isFinite(result))
    throw new RangeError("Периметр вне числового диапазона");
  return result;
}
