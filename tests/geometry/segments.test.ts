import { describe, it, expect } from "vitest";
import {
  intersectSegments,
  nearestOnSegment,
  pointOnSegment,
  projectToLine,
  type Segment,
} from "../../src/geometry/segments";
import {
  polygonArea,
  distance,
  perimeter,
} from "../../src/geometry/primitives";
import { rotatePoint, translatePoint } from "../../src/geometry/transforms";
const segment = (x1: number, y1: number, x2: number, y2: number): Segment => ({
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
});
const reverse = (s: Segment): Segment => ({ start: s.end, end: s.start });
describe("segment intersection classifications", () => {
  it.each([
    [
      "cross",
      segment(0, 0, 4, 0),
      segment(2, -2, 2, 2),
      { kind: "point", point: { x: 2, y: 0 } },
    ],
    [
      "endpoint",
      segment(0, 0, 4, 0),
      segment(4, 0, 4, 3),
      { kind: "point", point: { x: 4, y: 0 } },
    ],
    [
      "T junction",
      segment(0, 0, 4, 0),
      segment(2, 0, 2, 3),
      { kind: "point", point: { x: 2, y: 0 } },
    ],
    ["parallel", segment(0, 0, 4, 0), segment(0, 1, 4, 1), { kind: "none" }],
    [
      "outside segments",
      segment(0, 0, 1, 0),
      segment(2, -1, 2, 1),
      { kind: "none" },
    ],
    [
      "collinear gap",
      segment(0, 0, 1, 0),
      segment(2, 0, 3, 0),
      { kind: "none" },
    ],
    [
      "overlap",
      segment(0, 0, 4, 0),
      segment(2, 0, 5, 0),
      { kind: "overlap", start: { x: 2, y: 0 }, end: { x: 4, y: 0 } },
    ],
    [
      "contained",
      segment(0, 0, 4, 0),
      segment(1, 0, 3, 0),
      { kind: "overlap", start: { x: 1, y: 0 }, end: { x: 3, y: 0 } },
    ],
    [
      "collinear touch",
      segment(0, 0, 1, 0),
      segment(1, 0, 3, 0),
      { kind: "point", point: { x: 1, y: 0 } },
    ],
    [
      "point on line",
      segment(2, 0, 2, 0),
      segment(0, 0, 4, 0),
      { kind: "point", point: { x: 2, y: 0 } },
    ],
    [
      "point off line",
      segment(2, 1, 2, 1),
      segment(0, 0, 4, 0),
      { kind: "none" },
    ],
    [
      "same points",
      segment(2, 1, 2, 1),
      segment(2, 1, 2, 1),
      { kind: "point", point: { x: 2, y: 1 } },
    ],
    [
      "different points",
      segment(2, 1, 2, 1),
      segment(2, 2, 2, 2),
      { kind: "none" },
    ],
  ] as const)(
    "%s is invariant under input and endpoint order",
    (_name, a, b, expected) => {
      for (const first of [a, reverse(a)])
        for (const second of [b, reverse(b)]) {
          expect(intersectSegments(first, second)).toEqual(expected);
          expect(intersectSegments(second, first)).toEqual(expected);
        }
    },
  );
  it("distinguishes almost parallel directions from a collinear overlap", () => {
    expect(
      intersectSegments(segment(0, 0, 1, 0), segment(0, -5e-17, 1, 5e-17)),
    ).toEqual({ kind: "point", point: { x: 0.5, y: 0 } });
  });
  it("uses distance tolerance, independent of segment length", () => {
    expect(
      intersectSegments(segment(0, 0, 1e6, 0), segment(0, 2e-9, 1e6, 2e-9)),
    ).toEqual({ kind: "none" });
    expect(
      intersectSegments(segment(0, 0, 1e6, 0), segment(0, 5e-10, 1e6, 5e-10))
        .kind,
    ).toBe("overlap");
  });
  it("handles very small segments with an explicit metric tolerance", () => {
    expect(
      intersectSegments(
        segment(0, 0, 1e-12, 0),
        segment(5e-13, -1e-12, 5e-13, 1e-12),
        1e-15,
      ),
    ).toEqual({ kind: "point", point: { x: 5e-13, y: 0 } });
  });
  it("is invariant under rigid transforms for analytical intersections", () => {
    for (let n = 0; n < 40; n++) {
      const angle = n * 0.137,
        offset = { x: n * 13.17, y: -n * 5.23 };
      const transform = (s: Segment): Segment => ({
        start: translatePoint(rotatePoint(s.start, angle), offset),
        end: translatePoint(rotatePoint(s.end, angle), offset),
      });
      const result = intersectSegments(
        transform(segment(-2, 0, 4, 0)),
        transform(segment(1, -3, 1, 5)),
      );
      expect(result.kind).toBe("point");
      if (result.kind !== "point") throw new Error("missing intersection");
      expect(
        distance(
          result.point,
          translatePoint(rotatePoint({ x: 1, y: 0 }, angle), offset),
        ),
      ).toBeLessThan(1e-10);
    }
  });
  it("rejects nonfinite coordinates and invalid tolerance", () => {
    expect(() =>
      intersectSegments(segment(0, 0, Infinity, 1), segment(0, 0, 1, 1)),
    ).toThrow();
    expect(() =>
      intersectSegments(segment(0, 0, 1, 1), segment(0, 1, 1, 0), 0),
    ).toThrow();
  });
});
describe("projection and stable measurements", () => {
  it("projects to infinite axis but clamps nearest point to the segment", () => {
    const line = segment(0, 0, 4, 0);
    expect(projectToLine({ x: 5, y: 2 }, line)).toEqual({
      point: { x: 5, y: 0 },
      parameter: 1.25,
    });
    expect(nearestOnSegment({ x: 5, y: 2 }, line)).toEqual({
      point: { x: 4, y: 0 },
      parameter: 1,
      distance: Math.sqrt(5),
    });
  });
  it("projects to a diagonal", () => {
    expect(
      nearestOnSegment({ x: 2, y: 0 }, segment(0, 0, 4, 4)).point.x,
    ).toBeCloseTo(1, 12);
    expect(
      nearestOnSegment({ x: 2, y: 0 }, segment(0, 0, 4, 4)).point.y,
    ).toBeCloseTo(1, 12);
  });
  it("supports a point segment without division by zero", () =>
    expect(nearestOnSegment({ x: 3, y: 4 }, segment(0, 0, 0, 0))).toEqual({
      point: { x: 0, y: 0 },
      parameter: 0,
      distance: 5,
    }));
  it("checks endpoints and proximity", () => {
    expect(pointOnSegment({ x: 4, y: 0 }, segment(0, 0, 4, 0))).toBe(true);
    expect(pointOnSegment({ x: 4.01, y: 0 }, segment(0, 0, 4, 0))).toBe(false);
  });
  it("preserves small areas far from the origin", () => {
    const base = [
      { x: 0, y: 0 },
      { x: 4.25, y: 0 },
      { x: 4.25, y: 3 },
      { x: 0, y: 3 },
    ];
    const shifted = base.map((p) => translatePoint(p, { x: 1e9, y: -1e9 }));
    expect(polygonArea(shifted)).toBe(12.75);
    expect(perimeter(shifted)).toBe(14.5);
    expect(polygonArea([...shifted].reverse())).toBe(12.75);
  });
  it("does not accept nonfinite coordinates in measurements", () => {
    expect(() => distance({ x: 0, y: 0 }, { x: NaN, y: 0 })).toThrow();
    expect(() => polygonArea([{ x: Infinity, y: 0 }])).toThrow();
  });
});

describe("tolerance edge cases", () => {
  it("returns the same representative for two nearby point segments", () => {
    const a = segment(0, 0, 0, 0),
      b = segment(5e-10, 0, 5e-10, 0);
    expect(intersectSegments(a, b)).toEqual(intersectSegments(b, a));
    expect(intersectSegments(a, b)).toEqual({
      kind: "point",
      point: { x: 2.5e-10, y: 0 },
    });
  });
  it("does not report a point farther than the metric tolerance from a segment", () => {
    const a = segment(0, 0, 1, 0),
      b = segment(1 + 9e-10, 9e-10, 1 + 9e-10, 1);
    expect(intersectSegments(a, b)).toEqual({ kind: "none" });
  });
});
