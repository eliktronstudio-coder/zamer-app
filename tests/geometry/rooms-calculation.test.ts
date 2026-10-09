import { describe, expect, it } from "vitest";
import type { ColumnSection, Opening, Point } from "../../src/domain/model";
import {
  detectRooms,
  pointInRoom,
  roomLabelPoint,
} from "../../src/geometry/rooms";
import { polygonArea } from "../../src/geometry/primitives";
import { defaultElement } from "../../src/editor/element-commands";
import {
  CalculationEngine,
  createRoom,
  reconcileRooms,
} from "../../src/calculation/engine";
import {
  calculateElement,
  calculateRoom,
  sectionArea,
} from "../../src/calculation/quantities";
import { floorId, wall, scene, uuid, deepFreeze } from "./fixtures";
const box = (w = 4.257, h = 3, x = 0, y = 0): Point[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];
const wallsFor = (points: Point[], first = 1) =>
  points.map((p, i) => wall(first + i, p, points[(i + 1) % points.length]));
const roomScene = (points = box()) => {
  const walls = wallsFor(points),
    face = detectRooms(walls).candidates[0];
  return reconcileRooms(
    { ...scene(walls), rooms: [createRoom(face, "Обмер", null)] },
    2.7,
  );
};
const opening = (
  id = 20,
  type: Opening["type"] = "window",
  offset = 0.3,
): Opening => ({
  id: uuid(id),
  floorId,
  kind: "opening",
  roomIds: [],
  metadata: {},
  wallId: uuid(1),
  type,
  offset,
  width: 1.2,
  height: 1.4,
  sill: type === "window" ? 0.9 : 0,
  side: "left",
});
describe("wall faces and room topology", () => {
  it("detects a precise closed rectangle without assigning a name", () => {
    const walls = wallsFor(box()),
      found = detectRooms(deepFreeze(walls));
    expect(found.candidates).toHaveLength(1);
    expect(polygonArea(found.candidates[0].boundary)).toBeCloseTo(12.771, 12);
    expect(found.problems).toEqual([]);
    expect(walls[0].measuredLength).toBe(4.257);
  });
  it("handles reversed wall directions, input order and arbitrary rotations", () => {
    const pts = box().map((p) => ({
      x: p.x * Math.cos(0.7) - p.y * Math.sin(0.7) + 8,
      y: p.x * Math.sin(0.7) + p.y * Math.cos(0.7) + 5,
    }));
    const walls = wallsFor(pts);
    const a = detectRooms(walls),
      b = detectRooms(
        walls
          .slice()
          .reverse()
          .map((w) => ({ ...w, start: w.end, end: w.start })),
      );
    expect(a.candidates[0].sourceKey).toBe(b.candidates[0].sourceKey);
    expect(polygonArea(a.candidates[0].boundary)).toBeCloseTo(12.771, 12);
  });
  it("calculates a concave L-shaped face", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 4 },
      { x: 0, y: 4 },
    ];
    const found = detectRooms(wallsFor(pts));
    expect(found.candidates).toHaveLength(1);
    expect(polygonArea(found.candidates[0].boundary)).toBe(7);
    expect(
      pointInRoom(roomLabelPoint(found.candidates[0]), found.candidates[0]),
    ).toBe(true);
  });
  it("preserves precision near a large coordinate origin", () => {
    const found = detectRooms(wallsFor(box(4.25, 3, 1e9, 1e9)));
    expect(polygonArea(found.candidates[0].boundary)).toBe(12.75);
  });
  it("does not close a real gap or a self-intersecting figure", () => {
    const walls = wallsFor(box());
    walls[3] = { ...walls[3], end: { x: 0, y: 0.001 } };
    expect(detectRooms(walls).candidates).toHaveLength(0);
    expect(detectRooms(walls).problems).toContain(
      "Есть незамкнутые участки стен",
    );
    expect(
      detectRooms(
        wallsFor([
          { x: 0, y: 0 },
          { x: 4, y: 3 },
          { x: 0, y: 3 },
          { x: 4, y: 0 },
        ]),
      ).candidates,
    ).toHaveLength(0);
  });
  it("partitions a room at endpoint-to-wall T junctions without modifying the source walls", () => {
    const walls = [
      ...wallsFor(box(4, 3)),
      wall(10, { x: 2, y: 0 }, { x: 2, y: 3 }),
    ];
    const found = detectRooms(walls);
    expect(found.candidates).toHaveLength(2);
    expect(found.candidates.map((r) => polygonArea(r.boundary))).toEqual([
      6, 6,
    ]);
    expect(walls[0].measuredLength).toBe(4);
    expect(found.candidates.every((r) => r.wallIds.includes(uuid(10)))).toBe(
      true,
    );
  });
  it("treats an inner enclosed component as a hole, avoiding duplicate area", () => {
    const found = detectRooms([
      ...wallsFor(box(6, 6)),
      ...wallsFor(box(2, 2, 2, 2), 10),
    ]);
    expect(found.candidates).toHaveLength(2);
    const outer = found.candidates.find((c) => c.holes.length)!;
    expect(outer.holes).toHaveLength(1);
    expect(pointInRoom({ x: 3, y: 3 }, outer)).toBe(false);
    expect(polygonArea(outer.boundary) - polygonArea(outer.holes[0])).toBe(32);
  });
  it("ignores a dangling interior partition for closure but reports it", () => {
    const found = detectRooms([
      ...wallsFor(box()),
      wall(10, { x: 1, y: 0 }, { x: 1, y: 1 }),
    ]);
    expect(found.candidates).toHaveLength(1);
    expect(found.problems).toContain("Есть незамкнутые участки стен");
  });
  it("rejects overlapping boundaries", () => {
    const walls = wallsFor(box());
    expect(
      detectRooms([...walls, { ...walls[0], id: uuid(10) }]).candidates,
    ).toHaveLength(0);
  });
});
describe("quantities and explicit recalculation", () => {
  it("computes rectangle area, ceiling, perimeter, surfaces and volume without rounding", () => {
    const s = roomScene(),
      room = s.rooms![0],
      q = calculateRoom(room, deepFreeze(s), 2.7);
    expect(q.contourArea).toBeCloseTo(12.771, 12);
    expect(q.floorArea).toBeCloseTo(12.771, 12);
    expect(q.ceilingArea).toBeCloseTo(12.771, 12);
    expect(q.perimeter).toBeCloseTo(14.514, 12);
    expect(q.grossWallArea).toBeCloseTo(39.1878, 12);
    expect(q.volume).toBeCloseTo(34.4817, 12);
    expect(q.complete).toBe(true);
  });
  it("deducts windows and doors, including sill-aware reveals and an explicit reveal depth", () => {
    const s = roomScene(),
      window = opening(),
      door = {
        ...opening(21, "door", 2),
        width: 0.9,
        height: 2.1,
        revealDepth: 0.257,
      };
    const next = { ...s, elements: [window, door] },
      q = calculateRoom(s.rooms![0], next, 2.7);
    expect(q.windowArea).toBeCloseTo(1.68, 12);
    expect(q.doorArea).toBeCloseTo(1.89, 12);
    expect(q.netWallArea).toBeCloseTo(39.1878 - 3.57, 12);
    expect(q.revealLength).toBeCloseTo(5.2 + 5.1, 12);
    expect(q.revealArea).toBeCloseTo(5.2 * 0.1 + 5.1 * 0.257, 12);
  });
  it("does not produce a plausible net result from invalid or overlapping openings", () => {
    const s = roomScene();
    for (const e of [
      { ...opening(), width: 5 },
      { ...opening(), sill: 3 },
    ]) {
      const q = calculateRoom(s.rooms![0], { ...s, elements: [e] }, 2.7);
      expect(q.netWallArea).toBeNull();
      expect(q.complete).toBe(false);
      expect(q.grossWallArea).not.toBeNull();
    }
    const q = calculateRoom(
      s.rooms![0],
      { ...s, elements: [opening(), opening(21)] },
      2.7,
    );
    expect(q.openingsArea).toBeNull();
  });
  it("clips and unions column footprints instead of subtracting their area twice", () => {
    const s = roomScene(box(4, 3)),
      a = defaultElement("column", floorId, 2.7);
    if (a.kind !== "column") throw new Error();
    const columns = [
      {
        ...a,
        position: { x: 2, y: 1.5 },
        section: { kind: "rectangle" as const, width: 1, depth: 1 },
      },
      {
        ...a,
        id: uuid(40),
        position: { x: 2.5, y: 1.5 },
        section: { kind: "rectangle" as const, width: 1, depth: 1 },
      },
    ];
    const q = calculateRoom(s.rooms![0], { ...s, elements: columns }, 2.7);
    expect(q.floorArea).toBe(10.5);
    expect(q.ceilingArea).toBe(10.5);
    const partial = { ...columns[0], position: { x: 0, y: 1.5 }, height: 1 };
    const clipped = calculateRoom(
      s.rooms![0],
      { ...s, elements: [partial] },
      2.7,
    );
    expect(clipped.floorArea).toBe(11.5);
    expect(clipped.ceilingArea).toBe(12);
  });
  it.each(["L", "T", "cross", "H", "U", "box"] as const)(
    "calculates %s profile area analytically from its true contour",
    (profile) => {
      const section: ColumnSection = {
        kind: "profile",
        profile,
        width: 4,
        depth: 6,
        web: 1,
        flange: 1,
      };
      const expected = { L: 9, T: 9, cross: 9, H: 12, U: 12, box: 16 }[profile];
      expect(sectionArea(section)).toBe(expected);
    },
  );
  it("uses analytic circle/ellipse area and unions overlapping composite parts", () => {
    expect(sectionArea({ kind: "circle", diameter: 2 })).toBe(Math.PI);
    expect(sectionArea({ kind: "ellipse", width: 2, depth: 4 })).toBe(
      2 * Math.PI,
    );
    expect(
      sectionArea({
        kind: "composite",
        parts: [
          {
            section: { kind: "rectangle", width: 2, depth: 2 },
            position: { x: 0, y: 0 },
            rotation: 0,
          },
          {
            section: { kind: "rectangle", width: 2, depth: 2 },
            position: { x: 1, y: 0 },
            rotation: 0,
          },
        ],
      }),
    ).toBe(6);
  });
  it("computes beam, solid stair and ramp quantities from exact parameters", () => {
    const beam = defaultElement("beam", floorId, 2.7),
      stair = defaultElement("stair", floorId, 2.7),
      ramp = defaultElement("ramp", floorId, 2.7);
    expect(calculateElement(beam).volume).toBeCloseTo(0.24, 12);
    expect(calculateElement(stair).volume).toBeCloseTo(2.475, 12);
    expect(calculateElement(ramp).volume).toBeCloseTo(0.72, 12);
    expect(calculateElement(ramp).surfaceArea).toBeCloseTo(
      1.2 * Math.hypot(4, 0.3),
      12,
    );
  });
  it("invalidates wall, opening and height dependencies while reusing unchanged results", () => {
    const engine = new CalculationEngine(),
      s = roomScene(),
      a = engine.evaluate(s, 2.7);
    expect(engine.evaluate(s, 2.7)).toBe(a);
    const withOpening = { ...s, elements: [opening()] },
      b = engine.evaluate(withOpening, 2.7);
    expect(b.floor.netWallArea).toBeCloseTo(a.floor.netWallArea! - 1.68, 12);
    expect(b.topology).toBe(a.topology);
    const high = { ...withOpening, rooms: [{ ...s.rooms![0], height: 3 }] };
    expect(engine.evaluate(high, 2.7).rooms[0].volume).toBeCloseTo(
      12.771 * 3,
      12,
    );
  });
  it("keeps identity and name when geometry changes, but marks broken rooms incomplete and preserves history data", () => {
    const s = roomScene(),
      room = { ...s.rooms![0], status: "completed" as const },
      before = { ...s, rooms: [room] };
    const next = reconcileRooms(
      { ...before, walls: before.walls.filter((w) => w.id !== uuid(1)) },
      2.7,
      before,
    );
    expect(next.rooms![0].id).toBe(room.id);
    expect(next.rooms![0].name).toBe("Обмер");
    expect(next.rooms![0].geometricallyClosed).toBe(false);
    expect(next.rooms![0].status).toBe("issues");
    expect(calculateRoom(next.rooms![0], next, 2.7).floorArea).toBeNull();
    expect(before.rooms[0].geometricallyClosed).toBe(true);
  });
  it("invalidates completed status after a relevant opening edit, preserving it for an unrelated element", () => {
    const s = roomScene(),
      before = {
        ...s,
        rooms: [{ ...s.rooms![0], status: "completed" as const }],
      };
    expect(
      reconcileRooms({ ...before, elements: [opening()] }, 2.7, before)
        .rooms![0].status,
    ).toBe("inProgress");
    const column = defaultElement("column", floorId, 2.7);
    if (column.kind !== "column") throw new Error();
    expect(
      reconcileRooms(
        { ...before, elements: [{ ...column, position: { x: 100, y: 100 } }] },
        2.7,
        before,
      ).rooms![0].status,
    ).toBe("completed");
  });
});

describe("project totals", () => {
  it("sums floors and flags unavailable values as partial", async () => {
    const { calculateProject } = await import("../../src/calculation/project");
    const f = new CalculationEngine().evaluate(roomScene(), 2.7).floor;
    const all = calculateProject([f, f]);
    expect(all.floorArea).toBeCloseTo(25.542, 12);
    expect(all.roomCount).toBe(2);
    expect(all.complete).toBe(true);
    const partial = calculateProject([
      f,
      { ...f, netWallArea: null, complete: false },
    ]);
    expect(partial.netWallArea).toBe(f.netWallArea);
    expect(partial.complete).toBe(false);
  });
});

describe("stored room integrity", () => {
  it("rejects forged closed boundaries and duplicate registrations but keeps broken repair metadata", async () => {
    const { assertRoomContours } = await import("../../src/geometry/rooms");
    const s = roomScene(),
      r = s.rooms![0];
    expect(() => assertRoomContours([r], s.walls)).not.toThrow();
    expect(() =>
      assertRoomContours(
        [
          {
            ...r,
            boundary: r.boundary.map((p, i) =>
              i === 0 ? { x: p.x + 0.1, y: p.y } : p,
            ),
          },
        ],
        s.walls,
      ),
    ).toThrow();
    expect(() =>
      assertRoomContours([r, { ...r, id: uuid(88) }], s.walls),
    ).toThrow();
    expect(() =>
      assertRoomContours([{ ...r, geometricallyClosed: false }], []),
    ).not.toThrow();
  });
});

describe("partial shared walls", () => {
  it("assigns openings only to rooms touching their actual span", () => {
    const walls = [
      ...wallsFor(box(6, 3)),
      wall(10, { x: 3, y: 0 }, { x: 3, y: 3 }),
    ];
    const faces = detectRooms(walls).candidates;
    const s = reconcileRooms(
      {
        ...scene(walls),
        elements: [opening(20, "window", 0.2)],
        rooms: faces.map((f, i) => createRoom(f, `Замер ${i}`, null)),
      },
      2.7,
    );
    expect(s.elements![0].roomIds).toHaveLength(1);
    const quantities = new CalculationEngine().evaluate(s, 2.7).rooms;
    expect(quantities.map((q) => q.windowArea).sort()).toEqual([0, 1.68]);
  });
});

describe("unique floor volumes", () => {
  it("includes each wall once in total construction volume and preserves invalid opening uncertainty", () => {
    const s = roomScene(),
      engine = new CalculationEngine();
    const result = engine.evaluate(s, 2.7).floor;
    expect(result.wallVolume).toBeCloseTo(14.514 * 0.2 * 2.7, 12);
    expect(result.constructionVolume).toBeCloseTo(result.wallVolume!, 12);
    const invalid = engine.evaluate(
      { ...s, elements: [{ ...opening(), width: 10 }] },
      2.7,
    ).floor;
    expect(invalid.constructionVolume).toBeNull();
    expect(invalid.complete).toBe(false);
  });
});
