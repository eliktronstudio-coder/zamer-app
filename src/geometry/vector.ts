import type { Point } from "../domain/model";

export function assertPoint(point: Point): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError("Координаты должны быть конечными числами");
  }
}
export function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`${name} должен быть больше нуля`);
}
export function add(a: Point, b: Point): Point {
  return checkedPoint(a.x + b.x, a.y + b.y);
}
export function subtract(a: Point, b: Point): Point {
  return checkedPoint(a.x - b.x, a.y - b.y);
}
export function multiply(point: Point, factor: number): Point {
  return checkedPoint(point.x * factor, point.y * factor);
}
export function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y;
}
export function cross(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x;
}
export function checkedPoint(x: number, y: number): Point {
  const point = { x, y };
  assertPoint(point);
  return point;
}
export function interpolate(a: Point, b: Point, parameter: number): Point {
  assertPoint(a);
  assertPoint(b);
  return add(a, multiply(subtract(b, a), parameter));
}
export function unitDirection(start: Point, toward: Point): Point {
  assertPoint(start);
  assertPoint(toward);
  const vector = subtract(toward, start);
  const length = Math.hypot(vector.x, vector.y);
  assertPositive(length, "Длина направления");
  return checkedPoint(vector.x / length, vector.y / length);
}
