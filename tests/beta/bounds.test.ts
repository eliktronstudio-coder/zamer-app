import { it, expect } from "vitest";
import {
  overlappingSegmentPairs,
  pointBounds,
  boundsOverlap,
} from "../../src/geometry/bounds";
import {
  GEOMETRY_EPSILON as EPS,
  polygonArea,
} from "../../src/geometry/primitives";
import { detectRooms } from "../../src/geometry/rooms";
import type { Segment } from "../../src/geometry/segments";
import { wall, deepFreeze } from "../geometry/fixtures";
it("broad phase matches the exhaustive bounding-box oracle in original order without mutation", () => {
  let seed = 1234567;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const input: Segment[] = Array.from({ length: 180 }, () => ({
    start: { x: random() * 100 - 50, y: random() * 100 - 50 },
    end: { x: random() * 100 - 50, y: random() * 100 - 50 },
  }));
  input.push(
    { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } },
    { start: { x: 1 + EPS / 2, y: 0 }, end: { x: 2, y: 0 } },
    { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } },
  );
  const expected: [number, number][] = [];
  for (let i = 0; i < input.length; i++)
    for (let j = i + 1; j < input.length; j++) {
      const a = input[i],
        b = input[j];
      if (
        Math.max(a.start.x, a.end.x) + EPS < Math.min(b.start.x, b.end.x) ||
        Math.max(b.start.x, b.end.x) + EPS < Math.min(a.start.x, a.end.x) ||
        Math.max(a.start.y, a.end.y) + EPS < Math.min(b.start.y, b.end.y) ||
        Math.max(b.start.y, b.end.y) + EPS < Math.min(a.start.y, a.end.y)
      )
        continue;
      expected.push([i, j]);
    }
  expect([...overlappingSegmentPairs(deepFreeze(input))]).toEqual(expected);
  expect([...overlappingSegmentPairs([])]).toEqual([]);
});
it("sparse 5000-segment broad phase does not fabricate intersection candidates", () => {
  const input = Array.from({ length: 5000 }, (_, i) => ({
    start: { x: i * 10, y: i % 2 },
    end: { x: i * 10 + 4.257, y: i % 2 },
  }));
  expect([...overlappingSegmentPairs(input)]).toEqual([]);
});
it("viewport bounds include crossing segments and thick walls whose centerline is offscreen", () => {
  const view = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  expect(
    boundsOverlap(
      view,
      pointBounds([
        { x: -100, y: 5 },
        { x: 100, y: 5 },
      ])!,
    ),
  ).toBe(true);
  expect(
    boundsOverlap(
      view,
      pointBounds(
        [
          { x: -2, y: 0 },
          { x: -2, y: 10 },
        ],
        2.1,
      )!,
    ),
  ).toBe(true);
  expect(
    boundsOverlap(
      view,
      pointBounds(
        [
          { x: 20, y: 20 },
          { x: 21, y: 21 },
        ],
        1,
      )!,
    ),
  ).toBe(false);
  expect(pointBounds([])).toBeNull();
});
it("node buckets retain epsilon joins and exact geometry at very large coordinates", () => {
  for (const x of [0, 1e9]) {
    const walls = [
      wall(1, { x, y: 0 }, { x: x + 4.257, y: 0 }),
      wall(2, { x: x + 4.257, y: 0 }, { x: x + 4.257, y: 3 }),
      wall(3, { x: x + 4.257, y: 3 }, { x, y: 3 }),
      wall(4, { x, y: 3 }, { x: x + (x === 0 ? EPS / 2 : 0), y: 0 }),
    ];
    const result = detectRooms(deepFreeze(walls));
    expect(result.candidates).toHaveLength(1);
    expect(polygonArea(result.candidates[0].boundary)).toBeCloseTo(12.771, 5);
    expect(walls[0].measuredLength).toBe(x === 0 ? 4.257 : 4.256999969482422);
  }
});
