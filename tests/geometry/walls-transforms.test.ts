import { describe, it, expect } from "vitest";
import {
  applyTransform,
  composeTransforms,
  invertTransform,
  rotationTransform,
  translationTransform,
  rotatePoint,
} from "../../src/geometry/transforms";
import {
  createMeasuredWall,
  endpointAtLength,
  orthogonalTarget,
  parseLengthInput,
  rotateWall,
  setWallLength,
  translateWall,
  wallEdges,
} from "../../src/geometry/walls";
import { distance, polygonArea } from "../../src/geometry/primitives";
import { deepFreeze, floorId, uuid, wall } from "./fixtures";
describe("transforms", () => {
  it("composes in documented order and roundtrips viewport coordinates", () => {
    const transform = composeTransforms(
      translationTransform({ x: 123, y: 456 }),
      { a: 80, b: 0, c: 0, d: 80, tx: 0, ty: 0 },
    );
    const p = { x: 4.257, y: -3.12 };
    const screen = applyTransform(p, transform);
    expect(screen.x).toBeCloseTo(463.56, 12);
    expect(screen.y).toBeCloseTo(206.4, 12);
    const restored = applyTransform(
      applyTransform(p, transform),
      invertTransform(transform),
    );
    expect(restored.x).toBeCloseTo(p.x, 12);
    expect(restored.y).toBeCloseTo(p.y, 12);
  });
  it("rotates about a pivot and preserves distances and area", () => {
    const pivot = { x: 7, y: 8 },
      p = { x: 10, y: 12 };
    const rotated = rotatePoint(p, Math.PI / 2, pivot);
    expect(rotated.x).toBeCloseTo(3, 12);
    expect(rotated.y).toBeCloseTo(11, 12);
    expect(distance(p, pivot)).toBeCloseTo(distance(rotated, pivot), 12);
    const viaMatrix = applyTransform(p, rotationTransform(Math.PI / 2, pivot));
    expect(distance(rotated, viaMatrix)).toBeLessThan(1e-12);
    const polygon = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 0, y: 4 },
    ];
    expect(
      polygonArea(polygon.map((p) => rotatePoint(p, 0.728, pivot))),
    ).toBeCloseTo(10, 12);
  });
  it("uses pivot-relative rotation far from origin", () => {
    const pivot = { x: 1e9, y: 1e9 };
    expect(rotatePoint({ x: 1e9 + 4, y: 1e9 + 3 }, Math.PI / 2, pivot)).toEqual(
      { x: 1e9 - 3, y: 1e9 + 4 },
    );
  });
  it("rejects singular and nonfinite transforms", () => {
    expect(() =>
      invertTransform({ a: 1, b: 2, c: 2, d: 4, tx: 0, ty: 0 }),
    ).toThrow();
    expect(() => rotatePoint({ x: 0, y: 0 }, NaN)).toThrow();
  });
});
describe("measured wall construction", () => {
  it.each([
    ["4,257", 4.257],
    ["4.257 м", 4.257],
    ["  +5,20 m ", 5.2],
    [".5", 0.5],
    ["0,001", 0.001],
  ])("parses %s without rounding", (text, value) =>
    expect(parseLengthInput(text)).toBe(value),
  );
  it.each(["0", "-1", "NaN", "Infinity", "1e5", "4,2,5", "", "1 000", "4,"])(
    "rejects ambiguous/invalid input %s",
    (text) => expect(() => parseLengthInput(text)).toThrow(),
  );
  it("uses the entered length rather than cursor distance", () => {
    const w = createMeasuredWall({
      id: uuid(1),
      floorId,
      start: { x: 2, y: 3 },
      toward: { x: 5, y: 7 },
      length: 4.257,
      thickness: 0.2,
      height: 2.7,
    });
    expect(w.measuredLength).toBe(4.257);
    expect(distance(w.start, w.end)).toBeCloseTo(4.257, 12);
  });
  it.each([
    { x: 4, y: 1 },
    { x: -4, y: 1 },
    { x: 1, y: 4 },
    { x: 1, y: -4 },
  ])("constrains 90° directions toward %j", (target) => {
    const p = endpointAtLength({ x: 0, y: 0 }, target, 4.257, true);
    expect(p.x === 0 || p.y === 0).toBe(true);
    expect(distance({ x: 0, y: 0 }, p)).toBe(4.257);
  });
  it("allows free angles and a deterministic tie in orthogonal mode", () => {
    expect(orthogonalTarget({ x: 1, y: 2 }, { x: 4, y: 5 })).toEqual({
      x: 4,
      y: 2,
    });
    const p = endpointAtLength({ x: 0, y: 0 }, { x: 1, y: 1 }, 2);
    expect(p.x).toBeCloseTo(Math.SQRT2, 12);
    expect(p.y).toBeCloseTo(Math.SQRT2, 12);
  });
  it("supports either fixed anchor without mutating the original", () => {
    const w = deepFreeze(wall(1));
    const next = setWallLength(w, 5.2);
    expect(next.start).toEqual(w.start);
    expect(next.end).toEqual({ x: 5.2, y: 0 });
    expect(w.end.x).toBe(4.25);
    const reversed = setWallLength(w, 5.2, "end");
    expect(reversed.end).toEqual(w.end);
    expect(reversed.start.x).toBeCloseTo(-0.95, 12);
    expect(reversed.measuredLength).toBe(5.2);
  });
  it("keeps UUIDs, relationships and manual lengths during rigid transforms", () => {
    const w = deepFreeze(
      wall(1, undefined, undefined, {
        roomIds: [uuid(700)],
        metadata: { material: "brick" },
      }),
    );
    const moved = translateWall(w, { x: 3, y: 2 });
    const rotated = rotateWall(moved, 0.31);
    expect(rotated.id).toBe(w.id);
    expect(rotated.roomIds).toEqual(w.roomIds);
    expect(rotated.metadata).toEqual(w.metadata);
    expect(rotated.measuredLength).toBe(4.25);
    expect(distance(rotated.start, rotated.end)).toBeCloseTo(4.25, 12);
  });
  it("computes physical wall edges from axis and thickness", () => {
    const edges = wallEdges(wall(1));
    expect(edges.left).toEqual({
      start: { x: 0, y: 0.1 },
      end: { x: 4.25, y: 0.1 },
    });
    expect(edges.right.start.y).toBe(-0.1);
    const vertical = wallEdges(wall(2, { x: 0, y: 0 }, { x: 0, y: 3 }));
    expect(vertical.left.start.x).toBe(-0.1);
    expect(vertical.right.start.x).toBe(0.1);
  });
  it("rejects zero directions and nonpositive measurements", () => {
    expect(() => endpointAtLength({ x: 1, y: 1 }, { x: 1, y: 1 }, 2)).toThrow();
    expect(() => setWallLength(wall(1), 0)).toThrow();
    expect(() => wallEdges(wall(1, { x: 0, y: 0 }, { x: 0, y: 0 }))).toThrow();
  });
});
