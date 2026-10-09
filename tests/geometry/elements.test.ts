import { describe, expect, it } from "vitest";
import type { ColumnSection, Opening } from "../../src/domain/model";
import {
  elementHit,
  localToWorld,
  openingProblems,
  openingSegment,
  parseElement,
  polygonError,
  sectionContours,
  translateElement,
} from "../../src/geometry/elements";
import {
  defaultElement,
  moveElement,
  putElement,
} from "../../src/editor/element-commands";
import { createEditorStore } from "../../src/editor/store";
import { deleteElement } from "../../src/editor/commands";
import {
  translateSceneWall,
  rotateSceneWall,
} from "../../src/geometry/constraints";
import { floorId, scene, wall, uuid, successful } from "./fixtures";
const opening = (overrides: Partial<Opening> = {}): Opening => ({
  id: uuid(20),
  floorId,
  roomIds: [],
  metadata: {},
  kind: "opening",
  type: "window",
  wallId: uuid(1),
  offset: 1,
  width: 1,
  height: 1.4,
  sill: 0.9,
  side: "left",
  ...overrides,
});
const all = () => [
  defaultElement("column", floorId, 2.7),
  defaultElement("beam", floorId, 2.7),
  defaultElement("stair", floorId, 2.7),
  defaultElement("ramp", floorId, 2.7),
  defaultElement("levelChange", floorId, 2.7),
  opening(),
];
describe("construction element geometry", () => {
  it("never places stale defaults while edited parameters are unconfirmed", () => {
    const store = createEditorStore(floorId, scene([]), 2.7);
    store.getState().setTool("column");
    store.setState({ draftDirty: true });
    store.getState().placeConstruction({ x: 1, y: 1 }, 80);
    expect(store.getState().scene.elements).toEqual([]);
    expect(store.getState().message).toContain("Примените параметры");
    store.setState({ draftDirty: false });
    store.getState().placeConstruction({ x: 1, y: 1 }, 80);
    expect(store.getState().scene.elements).toHaveLength(1);
  });
  it.each(["L", "T", "cross", "H", "U", "box"] as const)(
    "validates and draws %s with positive area",
    (profile) => {
      const section: ColumnSection = {
        kind: "profile",
        profile,
        width: 0.4,
        depth: 0.6,
        web: 0.08,
        flange: 0.08,
      };
      const column = defaultElement("column", floorId, 2.7);
      if (column.kind !== "column") throw new Error();
      const parsed = parseElement({ ...column, section });
      expect(parsed.kind === "column" && parsed.section).toBeDefined();
      const contours = sectionContours(section);
      expect(contours.every((p) => polygonError(p) === null)).toBe(true);
    },
  );
  it("does not select the hollow center of a box profile", () => {
    const e = defaultElement("column", floorId, 2.7);
    if (e.kind !== "column") throw new Error();
    const column = {
      ...e,
      section: {
        kind: "profile",
        profile: "box",
        width: 2,
        depth: 2,
        web: 0.1,
        flange: 0.1,
      } as ColumnSection,
    };
    expect(elementHit(column, { x: 0, y: 0 }, [], 0.01)).toBe(false);
    expect(elementHit(column, { x: 0.95, y: 0 }, [], 0.01)).toBe(true);
  });
  it("rejects impossible profile thicknesses and self-intersecting custom sections", () => {
    const e = defaultElement("column", floorId, 2.7);
    expect(() =>
      parseElement({
        ...e,
        section: {
          kind: "profile",
          profile: "H",
          width: 0.4,
          depth: 0.6,
          web: 0.08,
          flange: 0.4,
        },
      }),
    ).toThrow("Толщины");
    expect(() =>
      parseElement({
        ...e,
        section: {
          kind: "polygon",
          vertices: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
            { x: 1, y: 0 },
          ],
        },
      }),
    ).toThrow("пересекает");
  });
  it("hits rotated composite parts independently, including holes", () => {
    const e = defaultElement("column", floorId, 2.7);
    const column = {
      ...e,
      kind: "column",
      position: { x: 10, y: 20 },
      rotation: 90,
      section: {
        kind: "composite",
        parts: [
          {
            section: { kind: "rectangle", width: 2, depth: 0.2 },
            position: { x: 3, y: 0 },
            rotation: 90,
          },
          {
            section: { kind: "circle", diameter: 1 },
            position: { x: -3, y: 0 },
            rotation: 0,
          },
        ],
      },
    };
    const parsed = parseElement(column);
    expect(elementHit(parsed, { x: 10, y: 23.5 }, [], 0.01)).toBe(false);
    expect(elementHit(parsed, { x: 9.5, y: 23 }, [], 0.01)).toBe(true);
    expect(elementHit(parsed, { x: 10, y: 17 }, [], 0.01)).toBe(true);
  });
  it("preserves exact opening offset and follows translated and rotated walls", () => {
    const w = wall(1),
      e = opening({ offset: 1.257 });
    const original = { ...scene([w]), elements: [e] };
    const moved = successful(
      translateSceneWall(original, w.id, { x: 2, y: 3 }),
    ).scene;
    expect(moved.elements?.[0]).toEqual(e);
    expect(openingSegment(e, moved.walls)?.start.x).toBeCloseTo(3.257, 12);
    expect(openingSegment(e, moved.walls)?.start.y).toBe(3);
    const rotated = successful(
      rotateSceneWall(original, w.id, Math.PI / 2, { x: 0, y: 0 }),
    ).scene;
    expect(openingSegment(e, rotated.walls)?.start.y).toBeCloseTo(1.257, 12);
  });
  it("reports length, height and overlap issues without modifying source measurements", () => {
    const e = opening({ width: 4.257, height: 4 });
    expect(
      openingProblems(e, [wall(1)], [e, opening({ id: uuid(21) })]),
    ).toHaveLength(3);
    expect(e.width).toBe(4.257);
    expect(
      openingProblems(
        opening({ sill: 0, height: 1 }),
        [wall(1)],
        [opening({ id: uuid(21), sill: 1, height: 1 })],
      ),
    ).toEqual([]);
  });
  it("rejects invalid placements and preserves the model atomically", () => {
    const s = scene([wall(1)]);
    expect(() => putElement(s, opening({ offset: 4 }))).toThrow("длину");
    expect(() => putElement(s, opening({ wallId: uuid(2) }))).toThrow("связь");
    expect(s.elements).toEqual([]);
  });
  it("moves an opening along its wall and rejects an impossible move", () => {
    const s = { ...scene([wall(1)]), elements: [opening()] };
    const moved = moveElement(s, uuid(20), { x: 0.257, y: 1 });
    expect((moved.elements?.[0] as Opening).offset).toBeCloseTo(1.257, 12);
    expect(() => moveElement(s, uuid(20), { x: 4, y: 0 })).toThrow();
    expect(s.elements[0].offset).toBe(1);
  });
  it.each(all().filter((e) => e.kind !== "opening"))(
    "translates $kind without losing parameters",
    (e) => {
      const moved = translateElement(e, { x: 4.257, y: 3 }, []);
      if ("position" in moved)
        expect(moved.position).toEqual({ x: 4.257, y: 3 });
      else if (moved.kind === "beam")
        expect(moved.start).toEqual({ x: 4.257, y: 3 });
      else if (moved.kind === "levelChange")
        expect(moved.boundary[0]).toEqual({ x: 4.257, y: 3 });
      expect(moved.id).toBe(e.id);
      expect(e).not.toEqual(moved);
    },
  );
  it("deletes dependent openings only and restores all elements with undo", () => {
    const store = createEditorStore(
      floorId,
      { ...scene([wall(1)]), elements: all() },
      2.7,
    );
    store.getState().select(uuid(1));
    store.getState().remove();
    expect(store.getState().scene.elements).toHaveLength(5);
    store.getState().undo();
    expect(store.getState().scene.elements).toHaveLength(6);
    store.getState().redo();
    expect(store.getState().scene.walls).toHaveLength(0);
    expect(
      deleteElement({ ...scene([wall(1)]), elements: all() }, uuid(20)).walls,
    ).toHaveLength(1);
  });
  it("cancels unfinished boundaries and saves completed boundaries with undo", () => {
    const store = createEditorStore(floorId, scene([]), 2.7);
    store.getState().setTool("levelChange");
    store.getState().placeConstruction({ x: 0, y: 0 }, 80);
    store.getState().cancel();
    expect(store.getState().scene.elements).toEqual([]);
    store.getState().placeConstruction({ x: 0, y: 0 }, 80);
    store.getState().placeConstruction({ x: 2, y: 0 }, 80);
    store.getState().finishBoundary();
    expect(store.getState().scene.elements).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().scene.elements).toEqual([]);
  });
  it("accepts signed level elevations and rejects invalid stair/ramp sizes", () => {
    expect(
      parseElement({
        ...defaultElement("levelChange", floorId, 2.7),
        fromElevation: -0.257,
        toElevation: 0.1,
      }).kind,
    ).toBe("levelChange");
    expect(() =>
      parseElement({ ...defaultElement("stair", floorId, 2.7), steps: 1.5 }),
    ).toThrow();
    expect(() =>
      parseElement({ ...defaultElement("ramp", floorId, 2.7), length: 0 }),
    ).toThrow();
    expect(() =>
      parseElement({
        ...defaultElement("beam", floorId, 2.7),
        end: { x: 0, y: 0 },
      }),
    ).toThrow("нулевую");
  });
  it("roundtrips local coordinate directions", () => {
    const world = localToWorld({ x: 4.257, y: 0 }, { x: 5, y: 8 }, 90);
    expect(world.x).toBeCloseTo(5, 12);
    expect(world.y).toBeCloseTo(12.257, 12);
  });
});
