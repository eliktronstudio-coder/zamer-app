import { describe, it, expect } from "vitest";
import {
  evaluateIssues,
  applyRepair,
  sceneFingerprint,
} from "../../src/issues/engine";
import { createEditorStore } from "../../src/editor/store";
import { defaultElement } from "../../src/editor/element-commands";
import { validateScene } from "../../src/geometry/constraints";
import {
  wall,
  scene,
  floorId,
  uuid,
  dimension,
  deepFreeze,
} from "../geometry/fixtures";
const evaluate = (s: ReturnType<typeof scene>) =>
  evaluateIssues({ scene: s, floorId, height: 2.7 });
const gapScene = () =>
  scene([
    wall(1, { x: 0, y: 0 }, { x: 2, y: 0 }),
    wall(2, { x: 2.02, y: 0 }, { x: 2.02, y: 2 }),
  ]);
describe("issue rules and safe proposals", () => {
  it("has deterministic identities and does not modify source data", () => {
    const s = deepFreeze(gapScene()),
      before = sceneFingerprint(s),
      a = evaluate(s),
      b = evaluate(s);
    expect(a).toEqual(b);
    expect(sceneFingerprint(s)).toBe(before);
    expect(a.find((i) => i.ruleId === "small-wall-gap")).toMatchObject({
      floorId,
      severity: "warning",
      elementIds: [uuid(1), uuid(2)],
    });
  });
  it("detects crossings, partial overlap and orphaned dimensions", () => {
    const a = wall(1, { x: 0, y: 0 }, { x: 4, y: 0 }),
      b = wall(2, { x: 2, y: -1 }, { x: 2, y: 1 });
    expect(
      evaluate(scene([a, b])).some((i) => i.ruleId === "wall-crossing"),
    ).toBe(true);
    expect(
      evaluate(scene([a, wall(3, { x: 1, y: 0 }, { x: 2, y: 0 })])).some(
        (i) => i.ruleId === "wall-overlap",
      ),
    ).toBe(true);
    expect(
      evaluate(scene([a], [dimension(10, wall(88))])).some(
        (i) => i.ruleId === "missing-element",
      ),
    ).toBe(true);
  });
  it("finds missing manual dimensions without replacing them with geometric length", () => {
    const s = scene([wall(1, undefined, undefined, { measuredLength: null })]);
    expect(evaluate(s).some((i) => i.ruleId === "missing-measurement")).toBe(
      true,
    );
    expect(s.walls[0].measuredLength).toBeNull();
  });
  it("rejects big gaps as suggestions and keeps valid free walls editable", () => {
    const original = gapScene();
    const s = {
      ...original,
      walls: [
        original.walls[0],
        {
          ...original.walls[1],
          start: { x: 2.2, y: 0 },
          end: { x: 2.2, y: 2 },
        },
      ],
    };
    expect(evaluate(s).some((i) => i.ruleId === "small-wall-gap")).toBe(false);
    expect(
      evaluate(s).filter((i) => i.ruleId === "open-wall-end"),
    ).toHaveLength(4);
    expect(validateScene(s)).toEqual([]);
  });
  it("moves a wall without changing manual length, links endpoints, and supports undo/redo", () => {
    const s = gapScene(),
      store = createEditorStore(floorId, s, 2.7),
      proposal = store
        .getState()
        .issues.find((i) => i.repair?.kind === "connect-gap")!.repair!;
    expect(store.getState().scene).toEqual(s);
    store.getState().repairIssue(proposal);
    const fixed = store.getState().scene;
    expect(fixed.walls[1].start).toEqual(fixed.walls[0].end);
    expect(fixed.walls.map((w) => w.measuredLength)).toEqual([2, 2]);
    expect(fixed.junctions).toHaveLength(1);
    expect(validateScene(fixed)).toEqual([]);
    expect(
      store.getState().issues.some((i) => i.ruleId === "small-wall-gap"),
    ).toBe(false);
    store.getState().undo();
    expect(store.getState().scene).toEqual(s);
    store.getState().redo();
    expect(store.getState().scene).toEqual(fixed);
  });
  it("rejects stale proposals instead of overwriting later edits", () => {
    const s = gapScene(),
      proposal = evaluate(s).find((i) => i.repair)!.repair!;
    expect(() =>
      applyRepair(
        { ...s, walls: s.walls.map((w) => ({ ...w, height: 3 })) },
        proposal,
      ),
    ).toThrow("План изменился");
  });
  it("removes only an unattached identical wall with explicit proposal", () => {
    const a = wall(1),
      b = { ...a, id: uuid(2) },
      s = scene([a, b]);
    const proposal = evaluate(s).find(
      (i) => i.ruleId === "duplicate-wall",
    )!.repair!;
    expect(proposal.kind).toBe("delete-duplicate");
    expect(applyRepair(s, proposal).walls).toEqual([a]);
    expect(
      evaluate(scene([a, b], [dimension(10, b)])).find(
        (i) => i.ruleId === "duplicate-wall",
      )!.repair,
    ).toBeUndefined();
    expect(
      evaluate(scene([a, { ...b, thickness: 0.3 }])).find(
        (i) => i.ruleId === "duplicate-wall",
      )!.repair,
    ).toBeUndefined();
  });
  it("opening problems preserve measured input and identify the opening", () => {
    const a = wall(1),
      e = defaultElement("window", floorId, 2.7);
    if (e.kind !== "opening") throw new Error();
    const s = { ...scene([a]), elements: [{ ...e, wallId: a.id, width: 10 }] };
    expect(evaluate(s).filter((i) => i.ruleId === "opening")).toHaveLength(1);
    expect(s.elements[0].width).toBe(10);
  });
  it("compares stair/ramp rise only when endpoints match an explicit level line", () => {
    const stair = defaultElement("stair", floorId, 2.7),
      level = defaultElement("levelChange", floorId, 2.7);
    if (stair.kind !== "stair" || level.kind !== "levelChange")
      throw new Error();
    const s = {
      ...scene([]),
      elements: [
        { ...stair, position: { x: 0, y: 0 }, rotation: 0, length: 3, rise: 2 },
        {
          ...level,
          boundary: [
            { x: 0, y: 0 },
            { x: 3, y: 0 },
          ],
          fromElevation: 0,
          toElevation: 3,
        },
      ],
    };
    expect(evaluate(s).some((i) => i.ruleId === "level-mismatch")).toBe(true);
    expect(
      evaluate({
        ...s,
        elements: s.elements.map((e) =>
          e.kind === "stair" ? { ...e, rise: 3 } : e,
        ),
      }).some((i) => i.ruleId === "level-mismatch"),
    ).toBe(false);
  });
  it("flags overlapping columns but does not subtract their volumes or suggest deletion", () => {
    const e = defaultElement("column", floorId, 2.7);
    if (e.kind !== "column") throw new Error();
    const issues = evaluate({
      ...scene([]),
      elements: [e, { ...e, id: uuid(77) }],
    });
    expect(issues.find((i) => i.ruleId === "element-overlap")).toBeDefined();
    expect(
      issues.find((i) => i.ruleId === "element-overlap")!.repair,
    ).toBeUndefined();
  });
  it("supports additional rules and isolates faulty plugins from the editor", () => {
    const context = { scene: scene([]), floorId, height: 2.7 };
    const result = evaluateIssues(context, [
      {
        id: "broken",
        evaluate: () => {
          throw new Error("bad rule");
        },
      },
    ]);
    expect(result[0].ruleId).toBe("rule-failed");
    expect(result[0].severity).toBe("error");
  });
  it("showing an issue changes viewport request and selection without a geometry command", () => {
    const store = createEditorStore(floorId, gapScene(), 2.7),
      before = store.getState().scene;
    store
      .getState()
      .showIssue(
        store.getState().issues.find((i) => i.ruleId === "small-wall-gap")!,
      );
    expect(store.getState().selection).toBe(uuid(1));
    expect(store.getState().focusRequest?.points).toHaveLength(2);
    expect(store.getState().scene).toBe(before);
    expect(store.getState().past).toEqual([]);
  });
});

it("does not propose a small shift that introduces a new wall crossing", () => {
  const s = gapScene(),
    third = wall(3, { x: 1.99, y: 1 }, { x: 2.01, y: 1 });
  const issues = evaluate({ ...s, walls: [...s.walls, third] });
  expect(issues.find((i) => i.ruleId === "small-wall-gap")).toBeDefined();
  expect(
    issues.find((i) => i.ruleId === "small-wall-gap")!.repair,
  ).toBeUndefined();
});

it("does not recurse through a dimension that references itself", () => {
  const d = dimension(10, wall(1));
  const s = scene(
    [],
    [
      {
        ...d,
        from: { elementId: d.id, anchor: "start" },
        to: { elementId: d.id, anchor: "end" },
      },
    ],
  );
  const store = createEditorStore(floorId, s, 2.7),
    row = store.getState().issues.find((i) => i.ruleId === "missing-element")!;
  expect(row).toBeDefined();
  expect(() => store.getState().showIssue(row)).not.toThrow();
  expect(store.getState().focusRequest?.points).toEqual([{ x: 0, y: 0 }]);
});

it("room completion offers notes for linked level inconsistencies and permits later repair", async () => {
  const { detectRooms } = await import("../../src/geometry/rooms"),
    { createRoom } = await import("../../src/calculation/engine");
  const points = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 3 },
      { x: 0, y: 3 },
    ],
    walls = points.map((p, i) => wall(i + 1, p, points[(i + 1) % 4]));
  const stair = defaultElement("stair", floorId, 2.7),
    level = defaultElement("levelChange", floorId, 2.7);
  if (stair.kind !== "stair" || level.kind !== "levelChange") throw new Error();
  const room = createRoom(detectRooms(walls).candidates[0], "Замер", null);
  const s = {
    ...scene(walls),
    rooms: [room],
    elements: [
      {
        ...stair,
        position: { x: 0.5, y: 0.5 },
        rotation: 0,
        length: 3,
        width: 1,
        rise: 2,
      },
      {
        ...level,
        boundary: [
          { x: 0.5, y: 0.5 },
          { x: 3.5, y: 0.5 },
        ],
        fromElevation: 0,
        toElevation: 3,
      },
    ],
  };
  const store = createEditorStore(floorId, s, 2.7);
  expect(store.getState().finishRoom(room.id)).toBe(false);
  expect(store.getState().finishRoom(room.id, true)).toBe(true);
  expect(store.getState().scene.rooms![0].status).toBe("completedWithNotes");
  store.getState().updateElement({
    ...stair,
    position: { x: 0.5, y: 0.5 },
    rotation: 0,
    length: 3,
    width: 1,
    rise: 3,
  });
  expect(
    store.getState().issues.some((i) => i.ruleId === "level-mismatch"),
  ).toBe(false);
  expect(store.getState().finishRoom(room.id)).toBe(true);
});

it("never suggests deleting entities with duplicate UUIDs or accepts a forged repair", () => {
  const w = wall(1),
    s = scene([w, { ...w }]);
  expect(
    evaluate(s).find((i) => i.ruleId === "duplicate-wall")?.repair,
  ).toBeUndefined();
  const one = scene([w]);
  expect(() =>
    applyRepair(one, {
      kind: "delete-duplicate",
      wallId: w.id,
      label: "",
      explanation: "",
      source: sceneFingerprint(one),
    }),
  ).toThrow("Предложение больше недоступно");
});
