import { describe, it, expect } from "vitest";
import { createEditorStore } from "../../src/editor/store";
import { scene, wall, floorId } from "../geometry/fixtures";
const create = () =>
  createEditorStore(
    floorId,
    scene([
      wall(1, { x: 0, y: 0 }, { x: 4.257, y: 0 }),
      wall(2, { x: 4.257, y: 0 }, { x: 4.257, y: 3 }),
      wall(3, { x: 4.257, y: 3 }, { x: 0, y: 3 }),
      wall(4, { x: 0, y: 3 }, { x: 0, y: 0 }),
    ]),
    2.7,
  );
function register(store: ReturnType<typeof create>, name = "Обмер") {
  store.getState().setTool("room");
  store.getState().pickRoom({ x: 1, y: 1 });
  store.getState().registerRoom(name, null);
  return store.getState().scene.rooms![0];
}
describe("room commands", () => {
  it("calculates contours immediately but only saves a room on explicit registration", () => {
    const s = create();
    expect(s.getState().calculation.topology.candidates).toHaveLength(1);
    expect(s.getState().scene.rooms).toEqual([]);
    const r = register(s);
    expect(r.name).toBe("Обмер");
    expect(r.status).toBe("inProgress");
    expect(
      s.getState().scene.walls.every((w) => w.roomIds.includes(r.id)),
    ).toBe(true);
    expect(s.getState().calculation.rooms[0].floorArea).toBeCloseTo(12.771, 12);
    expect(s.getState().finishRoom(r.id)).toBe(true);
    expect(s.getState().scene.rooms![0].status).toBe("completed");
  });
  it("supports missing names, completion with notes, edits and undo", () => {
    const s = create(),
      r = register(s, "");
    expect(r.geometricallyClosed).toBe(true);
    expect(s.getState().finishRoom(r.id)).toBe(false);
    expect(s.getState().finishRoom(r.id, true)).toBe(true);
    expect(s.getState().scene.rooms![0].status).toBe("completedWithNotes");
    s.getState().updateRoom({
      ...s.getState().scene.rooms![0],
      name: "Помещение 1",
    });
    expect(s.getState().scene.rooms![0].status).toBe("inProgress");
    s.getState().undo();
    expect(s.getState().scene.rooms![0].name).toBe("");
    expect(s.getState().scene.rooms![0].status).toBe("completedWithNotes");
  });
  it("retains identity and name after a broken contour and restores quantities with undo", () => {
    const s = create(),
      r = register(s);
    s.getState().finishRoom(r.id);
    const original = s.getState().scene;
    s.getState().select(original.walls[0].id);
    s.getState().remove();
    expect(s.getState().scene.rooms![0]).toMatchObject({
      id: r.id,
      name: r.name,
      geometricallyClosed: false,
      status: "issues",
    });
    expect(s.getState().calculation.rooms[0].floorArea).toBeNull();
    expect(s.getState().calculation.floor.complete).toBe(false);
    s.getState().undo();
    expect(s.getState().scene).toEqual(original);
    expect(s.getState().calculation.rooms[0].floorArea).toBeCloseTo(12.771, 12);
  });
  it("deleting room metadata keeps walls and undo restores memberships", () => {
    const s = create(),
      r = register(s);
    s.getState().select(r.id);
    s.getState().remove();
    expect(s.getState().scene.rooms).toEqual([]);
    expect(s.getState().scene.walls).toHaveLength(4);
    expect(s.getState().scene.walls.every((w) => !w.roomIds.length)).toBe(true);
    s.getState().undo();
    expect(s.getState().scene.rooms![0].id).toBe(r.id);
  });
  it("explicitly rebinds a new contour while preserving room identity and user fields", () => {
    const s = create(),
      r = register(s);
    const old = s.getState().scene;
    s.getState().commit({
      ...old,
      walls: old.walls.map((w, i) => ({
        ...w,
        id: `00000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}`,
        roomIds: [],
      })),
    });
    expect(s.getState().scene.rooms![0].geometricallyClosed).toBe(false);
    s.getState().rebindRoom(r.id);
    s.getState().pickRoom({ x: 1, y: 1 });
    s.getState().registerRoom("", null);
    expect(s.getState().scene.rooms![0]).toMatchObject({
      id: r.id,
      name: r.name,
      geometricallyClosed: true,
    });
    expect(s.getState().calculation.rooms[0].complete).toBe(true);
  });
});
