import { describe, it, expect } from "vitest";
import { createEditorStore } from "../../src/editor/store";
import { updateWallProperties } from "../../src/editor/commands";
import { evaluateDimension } from "../../src/geometry/dimensions";
import {
  translateSceneWall,
  validateScene,
} from "../../src/geometry/constraints";
import {
  deepFreeze,
  dimension,
  floorId,
  scene,
  wall,
} from "../geometry/fixtures";
import {
  zoomAt,
  screenToWorld,
  worldToScreen,
} from "../../src/editor/viewport";
const empty = () => createEditorStore(floorId, scene([]), 2.7);
describe("editor commands and history", () => {
  it("starts empty and creates a precise linked chain without rounding", () => {
    const store = empty();
    store.getState().place({ x: 0, y: 0 }, 80);
    store.setState({ lengthInput: "4,257" });
    store.getState().place({ x: 5, y: 0 }, 80);
    store.setState({ lengthInput: "3" });
    store.getState().place({ x: 4.257, y: 4 }, 80);
    const s = store.getState();
    expect(s.scene.walls).toHaveLength(2);
    expect(s.scene.walls[0].measuredLength).toBe(4.257);
    expect(s.scene.walls[1].start).toEqual(s.scene.walls[0].end);
    expect(s.scene.junctions).toHaveLength(1);
    expect(s.scene.dimensions).toHaveLength(2);
    expect(validateScene(s.scene)).toEqual([]);
  });
  it("undo/redo restores the whole model including links and dimensions", () => {
    const store = empty();
    store.getState().place({ x: 0, y: 0 }, 80);
    store.getState().place({ x: 4, y: 0 }, 80);
    store.getState().place({ x: 4, y: 3 }, 80);
    const expected = store.getState().scene;
    store.getState().undo();
    expect(store.getState().scene.walls).toHaveLength(1);
    expect(store.getState().scene.junctions).toHaveLength(0);
    store.getState().undo();
    expect(store.getState().scene.walls).toHaveLength(0);
    store.getState().redo();
    store.getState().redo();
    expect(store.getState().scene).toEqual(expected);
  });
  it("new commands discard the redo branch", () => {
    const store = empty();
    store.getState().commit(scene([wall(1)]));
    store.getState().undo();
    store.getState().commit(scene([wall(2)]));
    expect(store.getState().future).toEqual([]);
  });
  it("invalid input and repeated zero-length clicks do not create walls", () => {
    const store = empty();
    store.getState().place({ x: 0, y: 0 }, 80);
    store.setState({ lengthInput: "-2" });
    store.getState().place({ x: 1, y: 0 }, 80);
    expect(store.getState().scene.walls).toHaveLength(0);
    store.setState({ lengthInput: "" });
    store.getState().place({ x: 0, y: 0 }, 80);
    expect(store.getState().scene.walls).toHaveLength(0);
  });
  it("delete/undo restores dependent dimensions and junctions", () => {
    const store = empty();
    store.getState().place({ x: 0, y: 0 }, 80);
    store.getState().place({ x: 4, y: 0 }, 80);
    store.getState().place({ x: 4, y: 3 }, 80);
    const before = store.getState().scene;
    store.getState().select(before.walls[0].id);
    store.getState().remove();
    expect(store.getState().scene.dimensions).toHaveLength(1);
    expect(store.getState().scene.junctions).toHaveLength(0);
    store.getState().undo();
    expect(store.getState().scene).toEqual(before);
  });
  it("groups translation into one command and keeps associative references", () => {
    const w = wall(1),
      d = dimension(10, w);
    const store = createEditorStore(floorId, deepFreeze(scene([w], [d])), 2.7);
    store
      .getState()
      .apply(translateSceneWall(store.getState().scene, w.id, { x: 2, y: 1 }));
    expect(store.getState().past).toHaveLength(1);
    expect(evaluateDimension(d, store.getState().scene.walls)).toMatchObject({
      ok: true,
      from: { x: 2, y: 1 },
      value: 4.25,
    });
    store.getState().undo();
    expect(store.getState().scene.walls[0]).toEqual(w);
  });
  it("changing height, thickness and length is atomic and supports legacy walls without dimensions", () => {
    const w = wall(1);
    const original = deepFreeze(scene([w]));
    const next = updateWallProperties(original, w.id, {
      length: 5.2,
      thickness: 0.3,
      height: 3,
    });
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error("failed");
    expect(next.scene.walls[0]).toMatchObject({
      measuredLength: 5.2,
      thickness: 0.3,
      height: 3,
    });
    expect(next.scene.dimensions).toHaveLength(1);
    expect(original.walls[0].end.x).toBe(4.25);
  });
  it("history is bounded and no-op edits do not enter it", () => {
    const store = empty();
    store.getState().commit(scene([]));
    expect(store.getState().past).toHaveLength(0);
    for (let i = 1; i <= 120; i++) store.getState().commit(scene([wall(i)]));
    expect(store.getState().past).toHaveLength(100);
  });
});
describe("viewport coordinate contract", () => {
  it("zoom preserves the world point under the cursor and clamps scale", () => {
    const v = { x: 50, y: 70, scale: 80 },
      cursor = { x: 170, y: 200 };
    const before = screenToWorld(cursor, v),
      after = zoomAt(v, cursor, 160);
    expect(screenToWorld(cursor, after)).toEqual(before);
    expect(zoomAt(v, cursor, 1e6).scale).toBe(600);
    expect(zoomAt(v, cursor, 0).scale).toBe(15);
  });
  it("roundtrips world and screen points", () => {
    const v = { x: -123, y: 84, scale: 75 },
      p = { x: 4.257, y: 3 };
    expect(screenToWorld(worldToScreen(p, v), v).x).toBeCloseTo(p.x, 12);
  });
});
