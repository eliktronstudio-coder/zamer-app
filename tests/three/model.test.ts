import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  buildFloorModel,
  disposeModel,
  wallProfile,
} from "../../src/features/three/model";
import { sourcePoints } from "../../src/features/three/source-points";
import { wall, scene, uuid } from "../geometry/fixtures";
import type {
  Floor,
  Opening,
  ConstructionElement,
  Room,
} from "../../src/domain/model";
const floor: Floor = {
  id: uuid(999),
  projectId: uuid(998),
  name: "Этаж",
  elevation: 3,
  defaultHeight: 2.7,
  order: 0,
};
const opening = (
  n: number,
  w = wall(1),
  extra: Partial<Opening> = {},
): Opening => ({
  id: uuid(n),
  floorId: floor.id,
  roomIds: [],
  metadata: {},
  kind: "opening",
  type: "window",
  wallId: w.id,
  offset: 1,
  width: 1,
  height: 1,
  sill: 1,
  side: "left",
  ...extra,
});
function volume(g: THREE.BufferGeometry) {
  const p = g.getAttribute("position"),
    i = g.index;
  let v = 0;
  for (let n = 0; n < (i ? i.count : p.count); n += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(p, i ? i.getX(n) : n),
      b = new THREE.Vector3().fromBufferAttribute(p, i ? i.getX(n + 1) : n + 1),
      c = new THREE.Vector3().fromBufferAttribute(p, i ? i.getX(n + 2) : n + 2);
    v += a.dot(b.cross(c)) / 6;
  }
  return Math.abs(v);
}
const base = { floorId: floor.id, roomIds: [], metadata: {} };
function model(elements: ConstructionElement[] = []) {
  return buildFloorModel({ ...scene([wall(1)]), elements }, floor);
}
describe("3D uses the measured model", () => {
  it("preserves wall dimensions, floor elevation and source UUID", () => {
    const m = model(),
      wallMesh = m.group.children[0] as THREE.Mesh;
    const b = new THREE.Box3().setFromObject(wallMesh);
    expect(b.min.y).toBeCloseTo(3);
    expect(b.max.y).toBeCloseTo(5.7);
    expect(b.max.x - b.min.x).toBeCloseTo(4.25);
    expect(b.max.z - b.min.z).toBeCloseTo(0.2);
    expect(wallMesh.userData.sourceId).toBe(uuid(1));
    disposeModel(m.group);
  });
  it("cuts a real opening and leaves lintel/sill surfaces", () => {
    const m = model([opening(2)]),
      mesh = m.group.children[0] as THREE.Mesh;
    expect(volume(mesh.geometry)).toBeCloseTo((4.25 * 2.7 - 1) * 0.2, 5);
    const ray = new THREE.Raycaster(
      new THREE.Vector3(1.5, 4.5, 2),
      new THREE.Vector3(0, 0, -1),
    );
    expect(ray.intersectObject(mesh)).toHaveLength(0);
    ray.set(new THREE.Vector3(0.5, 4.5, 2), new THREE.Vector3(0, 0, -1));
    expect(ray.intersectObject(mesh).length).toBeGreaterThan(0);
    disposeModel(m.group);
  });
  it("door reaching the floor creates an open notch, void has no filler", () => {
    const m = model([
      opening(2, wall(1), { type: "void", sill: 0, height: 2 }),
    ]);
    expect(m.group.children).toHaveLength(1);
    expect(volume((m.group.children[0] as THREE.Mesh).geometry)).toBeCloseTo(
      (4.25 * 2.7 - 2) * 0.2,
      5,
    );
    disposeModel(m.group);
  });
  it("overlapping openings cut the union rather than double subtracting", () => {
    const p = wallProfile(wall(1), [
      opening(2),
      opening(3, wall(1), { offset: 1.5 }),
    ]);
    const m = model([opening(2), opening(3, wall(1), { offset: 1.5 })]);
    expect(p.polygons).toHaveLength(1);
    expect(volume((m.group.children[0] as THREE.Mesh).geometry)).toBeCloseTo(
      (4.25 * 2.7 - 1.5) * 0.2,
      5,
    );
    disposeModel(m.group);
  });
  it("keeps invalid opening input and warns instead of clipping its dimensions", () => {
    const o = opening(2, wall(1), { width: 10 }),
      before = JSON.stringify(o),
      m = model([o]);
    expect(m.warnings[0].id).toBe(o.id);
    expect(m.group.children).toHaveLength(1);
    expect(JSON.stringify(o)).toBe(before);
    disposeModel(m.group);
  });
  it("handles rotated walls in the same plan coordinate convention", () => {
    const w = wall(1, { x: 2, y: 3 }, { x: 2, y: 7 }),
      m = buildFloorModel(scene([w]), floor),
      b = new THREE.Box3().setFromObject(m.group);
    expect(b.min.x).toBeCloseTo(1.9);
    expect(b.max.x).toBeCloseTo(2.1);
    expect(b.min.z).toBeCloseTo(-7);
    expect(b.max.z).toBeCloseTo(-3);
    disposeModel(m.group);
  });
  it("box column retains its void and exact height", () => {
    const m = model([
        {
          ...base,
          id: uuid(2),
          kind: "column",
          position: { x: 0, y: 0 },
          rotation: 0,
          height: 3,
          material: "Бетон",
          section: {
            kind: "profile",
            profile: "box",
            width: 1,
            depth: 1,
            web: 0.1,
            flange: 0.1,
          },
        },
      ]),
      mesh = m.group.children.find(
        (o) => o.userData.sourceId === uuid(2),
      ) as THREE.Mesh;
    expect(volume(mesh.geometry)).toBeCloseTo((1 - 0.8 * 0.8) * 3, 5);
    const ray = new THREE.Raycaster(
      new THREE.Vector3(0, 10, 0),
      new THREE.Vector3(0, -1, 0),
    );
    expect(ray.intersectObject(mesh)).toHaveLength(0);
    disposeModel(m.group);
  });
  it("composite column extrudes the union of overlapping sections", () => {
    const section = { kind: "rectangle" as const, width: 1, depth: 1 },
      m = model([
        {
          ...base,
          id: uuid(2),
          kind: "column",
          position: { x: 0, y: 0 },
          rotation: 30,
          height: 2,
          material: "Бетон",
          section: {
            kind: "composite",
            parts: [
              { section, position: { x: 0, y: 0 }, rotation: 0 },
              { section, position: { x: 0.5, y: 0 }, rotation: 0 },
            ],
          },
        },
      ]),
      mesh = m.group.children.find(
        (o) => o.userData.sourceId === uuid(2),
      ) as THREE.Mesh;
    expect(volume(mesh.geometry)).toBeCloseTo(3, 5);
    disposeModel(m.group);
  });
  it("places beams at their declared elevation", () => {
    const m = model([
        {
          ...base,
          id: uuid(2),
          kind: "beam",
          start: { x: 0, y: 0 },
          end: { x: 3, y: 0 },
          width: 0.3,
          height: 0.5,
          elevation: 2,
          material: "Бетон",
        },
      ]),
      mesh = m.group.children.find((o) => o.userData.sourceId === uuid(2))!,
      b = new THREE.Box3().setFromObject(mesh);
    expect(b.min.y).toBeCloseTo(5);
    expect(b.max.y).toBeCloseTo(5.5);
    disposeModel(m.group);
  });
  it("constructs each stair tread with the original source binding", () => {
    const m = model([
        {
          ...base,
          id: uuid(2),
          kind: "stair",
          position: { x: 0, y: 0 },
          rotation: 0,
          width: 1,
          length: 4,
          rise: 2,
          steps: 4,
        },
      ]),
      steps = m.group.children.filter((o) => o.userData.sourceId === uuid(2));
    expect(steps).toHaveLength(4);
    expect(new THREE.Box3().setFromObject(steps[0]).max.y).toBeCloseTo(3.5);
    expect(new THREE.Box3().setFromObject(steps[3]).max.y).toBeCloseTo(5);
    disposeModel(m.group);
  });
  it.each([2, 0, -2])(
    "builds a ramp for rise %s without zero-thickness triangles",
    (rise) => {
      const m = model([
          {
            ...base,
            id: uuid(2),
            kind: "ramp",
            position: { x: 0, y: 0 },
            rotation: 0,
            width: 1,
            length: 4,
            rise,
          },
        ]),
        mesh = m.group.children.find(
          (o) => o.userData.sourceId === uuid(2),
        ) as THREE.Mesh;
      expect(volume(mesh.geometry)).toBeGreaterThan(0);
      const b = new THREE.Box3().setFromObject(mesh);
      expect(b.max.y).toBeCloseTo(3 + Math.max(0, rise));
      disposeModel(m.group);
    },
  );
  it("models both a level boundary and an elevated area", () => {
    const m = model([
      {
        ...base,
        id: uuid(2),
        kind: "levelChange",
        boundary: [
          { x: 0, y: 0 },
          { x: 3, y: 0 },
        ],
        fromElevation: 0,
        toElevation: 0.4,
      },
      {
        ...base,
        id: uuid(3),
        kind: "levelChange",
        boundary: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        fromElevation: 0,
        toElevation: 0.5,
      },
    ]);
    expect(
      m.group.children.filter((o) =>
        [uuid(2), uuid(3)].includes(o.userData.sourceId),
      ),
    ).toHaveLength(2);
    disposeModel(m.group);
  });
  it("room holes remain open in the floor slab", () => {
    const room: Room = {
        id: uuid(5),
        floorId: floor.id,
        name: "Зал",
        sourceKey: "fixture",
        wallIds: [],
        edges: [],
        height: null,
        geometricallyClosed: true,
        status: "inProgress",
        boundary: [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 4, y: 4 },
          { x: 0, y: 4 },
        ],
        holes: [
          [
            { x: 1, y: 1 },
            { x: 2, y: 1 },
            { x: 2, y: 2 },
            { x: 1, y: 2 },
          ],
        ],
      },
      m = buildFloorModel({ ...scene([]), rooms: [room] }, floor);
    expect(volume((m.group.children[0] as THREE.Mesh).geometry)).toBeCloseTo(
      15 * 0.05,
      5,
    );
    disposeModel(m.group);
  });
  it("empty and degenerate walls do not produce NaN geometry", () => {
    const m = buildFloorModel(
      scene([wall(1, { x: 0, y: 0 }, { x: 0, y: 0 })]),
      floor,
    );
    expect(m.group.children).toHaveLength(0);
    expect(m.warnings).toHaveLength(1);
    disposeModel(m.group);
  });
  it("generation leaves the complete input untouched and 2D resolves source points", () => {
    const s = { ...scene([wall(1)]), elements: [opening(2)] },
      before = JSON.stringify(s),
      m = buildFloorModel(s, floor);
    expect(JSON.stringify(s)).toBe(before);
    expect(sourcePoints(s, uuid(2))).toEqual([
      s.walls[0].start,
      s.walls[0].end,
    ]);
    disposeModel(m.group);
  });
});

it("a wall fully occupied by a valid window still renders its glazing", () => {
  const m = model([
    opening(2, wall(1), { offset: 0, width: 4.25, sill: 0, height: 2.7 }),
  ]);
  expect(m.group.children).toHaveLength(1);
  expect(m.group.children[0].userData.kind).toBe("window");
  disposeModel(m.group);
});
