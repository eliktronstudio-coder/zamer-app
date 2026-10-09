import { describe, it, expect } from "vitest";
import { createProject, changeStatus } from "../src/domain/projects";
import { parseSnapshot, serializeSnapshot } from "../src/domain/snapshot";
import { distance, polygonArea, perimeter } from "../src/geometry/primitives";
import { formatLength } from "../src/app/format";
import type { ProjectSnapshot } from "../src/domain/model";
const snapshot = (): ProjectSnapshot => {
  const { project, floor } = createProject("Офис", "Этаж 1");
  return {
    schemaVersion: 5,
    geometrySchemaVersion: 4,
    exportSchemaVersion: 5,
    project,
    floors: [floor],
    walls: [],
    junctions: [],
    dimensions: [],
    elements: [],
    rooms: [],
    defects: [],
    photos: [],
  };
};
describe("project model", () => {
  it("creates a guest project and linked floor without demo geometry", () => {
    const s = snapshot();
    expect(s.project.ownerId).toBeNull();
    expect(s.floors[0].projectId).toBe(s.project.id);
    expect(s.walls).toEqual([]);
  });
  it("rejects blank names", () =>
    expect(() => createProject("  ", "Этаж")).toThrow());
  it("preserves identity when trashing and restoring", () => {
    const { project } = createProject("Объект", "Этаж");
    const trashed = changeStatus(project, "trashed");
    expect(trashed.deletedAt).not.toBeNull();
    const restored = changeStatus(trashed, "active");
    expect(restored.id).toBe(project.id);
    expect(restored.deletedAt).toBeNull();
    expect(restored.revision).toBe(2);
  });
});
describe("versioned snapshot contract", () => {
  it("roundtrips UUIDs and exact measured lengths", () => {
    const s = snapshot();
    s.walls.push({
      id: crypto.randomUUID(),
      floorId: s.floors[0].id,
      roomIds: [],
      metadata: {},
      kind: "wall",
      start: { x: 0, y: 0 },
      end: { x: 4.257, y: 0 },
      measuredLength: 4.257,
      thickness: 0.2,
      height: 2.7,
    });
    expect(parseSnapshot(JSON.parse(serializeSnapshot(s)))).toEqual(s);
  });
  it("rejects unknown versions", () =>
    expect(() =>
      parseSnapshot({ ...snapshot(), schemaVersion: 99 }),
    ).toThrow());
  it("rejects orphan floors", () => {
    const s = snapshot();
    s.floors[0].projectId = crypto.randomUUID();
    expect(() => parseSnapshot(s)).toThrow();
  });
  it("rejects duplicate identifiers", () => {
    const s = snapshot();
    s.floors.push({ ...s.floors[0] });
    expect(() => parseSnapshot(s)).toThrow();
  });
  it("rejects orphan walls", () => {
    const s = snapshot();
    s.walls.push({
      id: crypto.randomUUID(),
      floorId: crypto.randomUUID(),
      roomIds: [],
      metadata: {},
      kind: "wall",
      start: { x: 0, y: 0 },
      end: { x: 4, y: 0 },
      measuredLength: null,
      thickness: 0.2,
      height: 2.7,
    });
    expect(() => parseSnapshot(s)).toThrow();
  });
});
describe("geometry foundations", () => {
  it("computes distances without display rounding", () =>
    expect(distance({ x: 0, y: 0 }, { x: 4.257, y: 0 })).toBe(4.257));
  it("computes rectangle area and perimeter", () => {
    const p = [
      { x: 0, y: 0 },
      { x: 4.25, y: 0 },
      { x: 4.25, y: 3 },
      { x: 0, y: 3 },
    ];
    expect(polygonArea(p)).toBeCloseTo(12.75, 12);
    expect(perimeter(p)).toBeCloseTo(14.5, 12);
    expect(polygonArea([...p].reverse())).toBe(12.75);
  });
  it("computes a concave polygon", () =>
    expect(
      polygonArea([
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 2 },
        { x: 2, y: 2 },
        { x: 2, y: 4 },
        { x: 0, y: 4 },
      ]),
    ).toBe(12));
  it("rounds only presentation", () => {
    const length = 4.257;
    expect(formatLength(length)).toBe("4,26 м");
    expect(length).toBe(4.257);
  });
});
