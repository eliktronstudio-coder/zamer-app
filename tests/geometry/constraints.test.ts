import { describe, it, expect } from "vitest";
import {
  applyDrivingDimension,
  connectEndpoints,
  detachEndpoint,
  rotateSceneWall,
  translateSceneWall,
  validateScene,
} from "../../src/geometry/constraints";
import { evaluateDimension } from "../../src/geometry/dimensions";
import { distance } from "../../src/geometry/primitives";
import {
  deepFreeze,
  dimension,
  junction,
  scene,
  successful,
  uuid,
  wall,
} from "./fixtures";
describe("associative dimensions", () => {
  it("resizes a wall from 4.25 to 5.20 and updates the driving value atomically", () => {
    const w = wall(1),
      d = dimension(10, w),
      s = deepFreeze(scene([w], [d]));
    const next = successful(applyDrivingDimension(s, d.id, 5.2));
    expect(next.scene.walls[0].end).toEqual({ x: 5.2, y: 0 });
    expect(next.scene.walls[0].measuredLength).toBe(5.2);
    expect(next.scene.dimensions[0].inputValue).toBe(5.2);
    expect(next.changedWallIds).toEqual([w.id]);
    expect(next.changedDimensionIds).toEqual([d.id]);
    expect(s.walls[0].end.x).toBe(4.25);
  });
  it("keeps the dimension origin fixed when the references are reversed", () => {
    const w = wall(1),
      d = dimension(10, w, {
        from: { elementId: w.id, anchor: "end" },
        to: { elementId: w.id, anchor: "start" },
      });
    const next = successful(applyDrivingDimension(scene([w], [d]), d.id, 5.2));
    expect(next.scene.walls[0].end).toEqual(w.end);
    expect(next.scene.walls[0].start.x).toBeCloseTo(-0.95, 12);
  });
  it("moves a reference dimension with a translated wall", () => {
    const w = wall(1),
      d = dimension(10, w, { mode: "reference", inputValue: null });
    const next = successful(
      translateSceneWall(scene([w], [d]), w.id, { x: 3, y: 2 }),
    );
    expect(evaluateDimension(d, next.scene.walls)).toEqual({
      ok: true,
      value: 4.25,
      from: { x: 3, y: 2 },
      to: { x: 7.25, y: 2 },
    });
    expect(next.scene.dimensions[0]).toEqual(d);
  });
  it("keeps identity and references during rotation", () => {
    const w = wall(1),
      d = dimension(10, w);
    const next = successful(
      rotateSceneWall(scene([w], [d]), w.id, Math.PI / 2),
    );
    const evaluated = evaluateDimension(d, next.scene.walls);
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) throw new Error("lost dimension");
    expect(evaluated.value).toBeCloseTo(4.25, 12);
    expect(evaluated.to.y).toBeCloseTo(4.25, 12);
    expect(next.scene.dimensions[0].from).toEqual(d.from);
  });
  it("recalculates other reference dimensions after a driving edit", () => {
    const w = wall(1),
      d = dimension(10, w),
      reference = dimension(11, w, {
        mode: "reference",
        inputValue: null,
        to: { elementId: w.id, anchor: "center" },
      });
    const next = successful(
      applyDrivingDimension(scene([w], [d, reference]), d.id, 4.257),
    );
    const evaluated = evaluateDimension(reference, next.scene.walls);
    expect(evaluated.ok && evaluated.value).toBe(4.257 / 2);
  });
  it("reports an orphan reference and cross-floor reference", () => {
    const w = wall(1),
      d = dimension(10, w);
    expect(evaluateDimension(d, [])).toMatchObject({
      ok: false,
      code: "missing-element",
    });
    expect(evaluateDimension({ ...d, floorId: uuid(998) }, [w])).toMatchObject({
      ok: false,
      code: "wrong-floor",
    });
  });
  it("rejects reference-only and unsupported driving dimensions", () => {
    const w = wall(1);
    for (const d of [
      dimension(10, w, { mode: "reference", inputValue: null }),
      dimension(10, w, {
        to: { elementId: w.id, anchor: "center" },
        inputValue: null,
      }),
    ])
      expect(applyDrivingDimension(scene([w], [d]), d.id, 5)).toMatchObject({
        ok: false,
        problems: [{ code: "unsupported-driving-dimension" }],
      });
  });
  it("rejects a second contradictory driving constraint without modifying either value", () => {
    const w = wall(1),
      a = dimension(10, w),
      b = dimension(11, w);
    const original = deepFreeze(scene([w], [a, b]));
    expect(applyDrivingDimension(original, a.id, 5)).toMatchObject({
      ok: false,
      problems: [{ code: "dimension-conflict" }],
    });
    expect(original.walls[0].end).toEqual({ x: 4.25, y: 0 });
    expect(original.dimensions.map((d) => d.inputValue)).toEqual([4.25, 4.25]);
  });
  it("does not discard sub-epsilon changes or invent a change for a no-op", () => {
    const w = wall(1),
      d = dimension(10, w);
    const original = scene([w], [d]);
    const length = 4.25 + 1e-10;
    const next = successful(applyDrivingDimension(original, d.id, length));
    expect(next.scene.walls[0].end.x).toBe(length);
    expect(next.scene.walls[0].measuredLength).toBe(length);
    const unchanged = successful(
      translateSceneWall(original, w.id, { x: 0, y: 0 }),
    );
    expect(unchanged.changedWallIds).toEqual([]);
    expect(unchanged.scene.walls[0]).toBe(w);
  });
});
describe("explicit endpoint relationships", () => {
  it("does not merge geometrically coincident points without a junction", () => {
    const a = wall(1),
      b = wall(2, a.end, { x: 4.25, y: 3 }, { measuredLength: null });
    const next = successful(
      applyDrivingDimension(scene([a, b], [dimension(10, a)]), uuid(10), 5.2),
    );
    expect(next.scene.walls[1]).toBe(b);
    expect(next.scene.walls[1].start).toEqual({ x: 4.25, y: 0 });
  });
  it("propagates an endpoint to all explicitly linked unmeasured walls", () => {
    const a = wall(1),
      b = wall(2, a.end, { x: 4.25, y: 3 }, { measuredLength: null }),
      c = wall(3, a.end, { x: 6, y: 2 }, { measuredLength: null });
    const link = {
      ...junction(20, a, b),
      endpoints: [
        ...junction(20, a, b).endpoints,
        { elementId: c.id, anchor: "start" as const },
      ],
    };
    const original = deepFreeze(scene([a, b, c], [dimension(10, a)], [link]));
    const next = successful(applyDrivingDimension(original, uuid(10), 5.2));
    expect(next.scene.walls[1].start).toEqual({ x: 5.2, y: 0 });
    expect(next.scene.walls[2].start).toEqual({ x: 5.2, y: 0 });
    expect(next.changedWallIds).toEqual([a.id, b.id, c.id]);
    expect(validateScene(next.scene)).toEqual([]);
    expect(original.walls[1].start.x).toBe(4.25);
  });
  it("rejects changes that stretch a measured neighbor atomically", () => {
    const a = wall(1),
      b = wall(2, a.end, { x: 4.25, y: 3 });
    const original = deepFreeze(
      scene([a, b], [dimension(10, a)], [junction(20, a, b)]),
    );
    expect(applyDrivingDimension(original, uuid(10), 5.2)).toMatchObject({
      ok: false,
      problems: [{ code: "measured-length-conflict", elementIds: [b.id] }],
    });
    expect(distance(original.walls[0].start, original.walls[0].end)).toBe(4.25);
    expect(original.walls[1].start.x).toBe(4.25);
  });
  it("supports explicit detach before an independent move", () => {
    const a = wall(1),
      b = wall(2, a.end, { x: 4.25, y: 3 });
    const original = scene([a, b], [], [junction(20, a, b)]);
    const detached = successful(
      detachEndpoint(original, { elementId: a.id, anchor: "end" }),
    );
    expect(detached.scene.junctions).toEqual([]);
    const next = successful(
      translateSceneWall(detached.scene, a.id, { x: 1, y: 1 }),
    );
    expect(next.scene.walls[1]).toBe(b);
  });
  it("connects only explicitly coincident endpoints and never closes a gap silently", () => {
    const a = wall(1),
      b = wall(2, { x: 4.26, y: 0 }, { x: 4.26, y: 3 });
    const original = scene([a, b]);
    expect(connectEndpoints(original, junction(20, a, b))).toMatchObject({
      ok: false,
      problems: [{ code: "disconnected-junction" }],
    });
    expect(original.junctions).toEqual([]);
    const coincident = wall(3, a.end, { x: 4.25, y: 3 });
    expect(
      successful(
        connectEndpoints(scene([a, coincident]), junction(21, a, coincident)),
      ).scene.junctions,
    ).toHaveLength(1);
  });
  it("rejects cross-floor links and multiple junction membership", () => {
    const a = wall(1),
      b = wall(2, a.end, { x: 4.25, y: 3 }, { floorId: uuid(998) });
    expect(connectEndpoints(scene([a, b]), junction(20, a, b))).toMatchObject({
      ok: false,
      problems: [{ code: "wrong-floor" }],
    });
    const sameFloor = { ...b, floorId: a.floorId },
      link = junction(20, a, sameFloor);
    expect(
      connectEndpoints(scene([a, sameFloor], [], [link]), {
        ...link,
        id: uuid(21),
      }),
    ).toMatchObject({ ok: false });
  });
  it("allows safe edits in the presence of unrelated existing issues", () => {
    const a = wall(1),
      orphan = dimension(10, wall(404), {
        mode: "reference",
        inputValue: null,
      });
    const next = successful(
      translateSceneWall(scene([a], [orphan]), a.id, { x: 1, y: 2 }),
    );
    expect(next.scene.walls[0].start).toEqual({ x: 1, y: 2 });
    expect(next.problems).toMatchObject([{ code: "missing-element" }]);
  });
  it("reports corrupt models, zero-length walls and missing command targets", () => {
    const a = wall(1);
    expect(validateScene(scene([a, a]))).toMatchObject([
      { code: "duplicate-id" },
    ]);
    expect(validateScene(scene([{ ...a, height: -1 }]))).toMatchObject([
      { code: "invalid-model" },
    ]);
    expect(
      validateScene(
        scene([
          wall(2, { x: 0, y: 0 }, { x: 0, y: 0 }, { measuredLength: null }),
        ]),
      ),
    ).toMatchObject([{ code: "degenerate-wall" }]);
    expect(
      translateSceneWall(scene([a]), uuid(404), { x: 1, y: 0 }),
    ).toMatchObject({ ok: false });
  });
});

describe("pre-existing issue handling", () => {
  it("allows a driving edit despite an unrelated broken dimension", () => {
    const a = wall(1),
      active = dimension(10, a),
      orphan = dimension(11, wall(404), {
        mode: "reference",
        inputValue: null,
      });
    const next = successful(
      applyDrivingDimension(scene([a], [active, orphan]), active.id, 4.257),
    );
    expect(next.scene.walls[0].measuredLength).toBe(4.257);
    expect(next.problems[0].code).toBe("missing-element");
  });
  it("does not stretch an already inconsistent measured neighbor", () => {
    const a = wall(1),
      b = wall(2, a.end, { x: 4.25, y: 3 }, { measuredLength: 2 });
    const original = deepFreeze(
      scene([a, b], [dimension(10, a)], [junction(20, a, b)]),
    );
    expect(applyDrivingDimension(original, uuid(10), 5.2)).toMatchObject({
      ok: false,
      problems: [{ code: "measured-length-conflict" }],
    });
    expect(original.walls[1].measuredLength).toBe(2);
  });
});
