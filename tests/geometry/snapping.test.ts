import { describe, it, expect } from "vitest";
import {
  snapPoint,
  type SnapOptions,
  type SnapProvider,
} from "../../src/geometry/snapping";
import { constructWall } from "../../src/geometry/construction";
import { distance } from "../../src/geometry/primitives";
import { deepFreeze, floorId, uuid, wall } from "./fixtures";
const base: SnapOptions = {
  pointer: { x: 0.02, y: 0.03 },
  walls: [wall(1)],
  floorId,
  pixelsPerMeter: 100,
  tolerancePixels: 8,
};
describe("snap providers", () => {
  it.each([
    ["start", { x: 0.02, y: 0.03 }, { x: 0, y: 0 }],
    ["end", { x: 4.23, y: 0.01 }, { x: 4.25, y: 0 }],
    ["center", { x: 2.1, y: 0.01 }, { x: 2.125, y: 0 }],
    ["nearest", { x: 1, y: 0.03 }, { x: 1, y: 0 }],
    ["edge", { x: 1, y: 0.11 }, { x: 1, y: 0.1 }],
    ["far-edge", { x: 1, y: 0.01 }, { x: 1, y: -0.1 }],
    ["axis", { x: 4.3, y: 0.02 }, { x: 4.3, y: 0 }],
  ] as const)("supports %s", (kind, pointer, expected) => {
    const result = snapPoint({
      ...base,
      pointer,
      tolerancePixels: 20,
      enabledKinds: [kind],
    });
    expect(result.candidate?.kind).toBe(kind);
    expect(result.point.x).toBeCloseTo(expected.x, 12);
    expect(result.point.y).toBeCloseTo(expected.y, 12);
  });
  it("finds intersections with stable source IDs", () => {
    const result = snapPoint({
      ...base,
      walls: [wall(2, { x: 2, y: -2 }, { x: 2, y: 2 }), wall(1)],
      pointer: { x: 2.01, y: 0.02 },
      enabledKinds: ["intersection"],
    });
    expect(result.point).toEqual({ x: 2, y: 0 });
    expect(result.candidate?.elementIds).toEqual([uuid(1), uuid(2)]);
  });
  it("does not invent an intersection point for a collinear overlap", () =>
    expect(
      snapPoint({
        ...base,
        walls: [wall(1), wall(2, { x: 1, y: 0 }, { x: 3, y: 0 })],
        pointer: { x: 2, y: 0 },
        enabledKinds: ["intersection"],
      }).candidate,
    ).toBeNull());
  it("resolves a linked anchor and ignores missing references", () => {
    const result = snapPoint({
      ...base,
      pointer: { x: 2.12, y: 0.01 },
      enabledKinds: ["linked"],
      linkedReferences: [
        { elementId: uuid(404), anchor: "end" },
        { elementId: uuid(1), anchor: "center" },
      ],
    });
    expect(result.candidate?.kind).toBe("linked");
    expect(result.point.x).toBe(2.125);
  });
  it("gives endpoints precedence over closer arbitrary projections", () => {
    const result = snapPoint(base);
    expect(result.candidate?.kind).toBe("start");
    expect(result.point).toEqual({ x: 0, y: 0 });
  });
  it("keeps the snap radius in screen pixels at different zoom levels", () => {
    expect(
      snapPoint({
        ...base,
        pointer: { x: 0.05, y: 0 },
        enabledKinds: ["start"],
        pixelsPerMeter: 100,
      }).candidate,
    ).not.toBeNull();
    expect(
      snapPoint({
        ...base,
        pointer: { x: 0.05, y: 0 },
        enabledKinds: ["start"],
        pixelsPerMeter: 200,
      }).candidate,
    ).toBeNull();
  });
  it("never snaps to another floor or mutates source data", () => {
    const options = deepFreeze({
      ...base,
      walls: [wall(1, undefined, undefined, { floorId: uuid(998) })],
    });
    expect(snapPoint(options).candidate).toBeNull();
    expect(options.pointer).toEqual({ x: 0.02, y: 0.03 });
  });
  it("supports disabling all snaps", () => {
    const result = snapPoint({ ...base, enabledKinds: [] });
    expect(result.point).toEqual(base.pointer);
    expect(result.candidates).toEqual([]);
  });
  it("keeps the selected orthogonal direction and rejects off-axis markers", () => {
    const result = snapPoint({
      ...base,
      walls: [
        wall(1, { x: 4, y: 0.01 }, { x: 5, y: 0.01 }),
        wall(2, { x: 0, y: 1 }, { x: 0, y: 2 }),
      ],
      pointer: { x: 4, y: 0.02 },
      enabledKinds: ["start"],
      orthogonalFrom: { x: 0, y: 0 },
    });
    expect(result.candidate).toBeNull();
    expect(result.point).toEqual({ x: 4, y: 0 });
  });
  it("does not switch to the perpendicular axis just to get a snap", () => {
    const result = snapPoint({
      ...base,
      walls: [wall(1, { x: 0, y: 0.04 }, { x: 0, y: 1 })],
      pointer: { x: 0.05, y: 0.04 },
      enabledKinds: ["start"],
      orthogonalFrom: { x: 0, y: 0 },
    });
    expect(result.candidate).toBeNull();
    expect(result.point).toEqual({ x: 0.05, y: 0 });
  });
  it("is deterministic with coincident candidates and reordered walls", () => {
    const a = wall(1),
      b = wall(2);
    const first = snapPoint({ ...base, walls: [a, b] });
    const second = snapPoint({ ...base, walls: [b, a] });
    expect(first).toEqual(second);
    expect(first.candidate?.elementIds).toEqual([a.id]);
  });
  it("accepts new providers without coupling them to React", () => {
    const provider: SnapProvider = {
      kind: "custom",
      priority: -1,
      candidates: () => [
        { kind: "custom", point: { x: 0, y: 0 }, elementIds: [] },
      ],
    };
    expect(
      snapPoint({ ...base, providers: [provider], enabledKinds: ["custom"] })
        .candidate?.kind,
    ).toBe("custom");
  });
  it("rejects invalid zoom, radius and duplicate providers", () => {
    expect(() => snapPoint({ ...base, pixelsPerMeter: 0 })).toThrow();
    expect(() => snapPoint({ ...base, tolerancePixels: NaN })).toThrow();
    const provider: SnapProvider = {
      kind: "a",
      priority: 0,
      candidates: () => [],
    };
    expect(() =>
      snapPoint({ ...base, providers: [provider, provider] }),
    ).toThrow();
  });
});
describe("wall construction pipeline", () => {
  const input = {
    id: uuid(30),
    floorId,
    start: { x: 0, y: 0 },
    pointer: { x: 4.23, y: 0.02 },
    length: null,
    thickness: 0.2,
    height: 2.7,
    orthogonal: true,
    snapping: {
      walls: [wall(1)],
      pixelsPerMeter: 100,
      tolerancePixels: 8,
      enabledKinds: ["end"],
    },
  };
  it("uses a snapped endpoint for a wall without a manual length", () => {
    const result = constructWall(input);
    expect(result.wall.end).toEqual({ x: 4.25, y: 0 });
    expect(result.wall.measuredLength).toBeNull();
    expect(result.snap?.kind).toBe("end");
  });
  it("keeps the exact manual length and suppresses an incompatible snap marker", () => {
    const result = constructWall({ ...input, length: 4.257 });
    expect(result.wall.measuredLength).toBe(4.257);
    expect(result.wall.end).toEqual({ x: 4.257, y: 0 });
    expect(result.snap).toBeNull();
  });
  it("retains a marker when both constraints agree", () =>
    expect(constructWall({ ...input, length: 4.25 }).snap?.kind).toBe("end"));
  it("finds a junction at the exact manual end when the direction pointer is only a ray", () => {
    const result = constructWall({
      ...input,
      pointer: { x: 1, y: 0 },
      length: 4.25,
    });
    expect(result.wall.end).toEqual({ x: 4.25, y: 0 });
    expect(result.snap?.kind).toBe("end");
  });
  it("supports free angles without snapping", () => {
    const result = constructWall({
      ...input,
      orthogonal: false,
      snapping: undefined,
      pointer: { x: 3, y: 4 },
      length: 4.257,
    });
    expect(result.wall.end.x).toBeCloseTo((4.257 * 3) / 5, 12);
    expect(distance(result.wall.start, result.wall.end)).toBeCloseTo(4.257, 12);
  });
  it("rejects a zero-length click rather than creating an invisible wall", () =>
    expect(() =>
      constructWall({ ...input, pointer: { x: 0, y: 0 }, snapping: undefined }),
    ).toThrow());
});
