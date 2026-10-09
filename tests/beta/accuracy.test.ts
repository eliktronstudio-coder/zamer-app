import { it, expect } from "vitest";
import { CalculationEngine, createRoom } from "../../src/calculation/engine";
import { detectRooms } from "../../src/geometry/rooms";
import type { Opening } from "../../src/domain/model";
import { wall, uuid, deepFreeze } from "../geometry/fixtures";
it("rotated measured rooms and window deductions stay well within the one percent specification", () => {
  let maxRelativeError = 0;
  for (let n = 0; n < 40; n++) {
    const angle = n * 0.157,
      offset = n % 2 ? 1e9 : 0;
    const points = [
      { x: 0, y: 0 },
      { x: 4.257, y: 0 },
      { x: 4.257, y: 3 },
      { x: 0, y: 3 },
    ].map((p) => ({
      x: offset + p.x * Math.cos(angle) - p.y * Math.sin(angle),
      y: offset + p.x * Math.sin(angle) + p.y * Math.cos(angle),
    }));
    const walls = points.map((p, i) =>
      wall(i + 1, p, points[(i + 1) % 4], {
        measuredLength: i % 2 === 0 ? 4.257 : 3,
      }),
    );
    const face = detectRooms(walls).candidates[0];
    expect(face).toBeDefined();
    const room = createRoom(face, "Точный замер", 2.7);
    const opening: Opening = {
      id: uuid(55),
      floorId: walls[0].floorId,
      kind: "opening",
      roomIds: [room.id],
      metadata: {},
      type: "window",
      wallId: walls[0].id,
      offset: 0.5,
      width: 1.2,
      height: 1.4,
      sill: 0.8,
      side: "left",
    };
    const scene = deepFreeze({
      walls,
      rooms: [room],
      elements: [opening],
      dimensions: [],
      junctions: [],
    });
    const result = new CalculationEngine().evaluate(scene, 2.7).rooms[0];
    const expected = {
      floorArea: 12.771,
      ceilingArea: 12.771,
      perimeter: 14.514,
      volume: 34.4817,
      grossWallArea: 39.1878,
      openingsArea: 1.68,
      netWallArea: 37.5078,
    };
    for (const [key, value] of Object.entries(expected)) {
      const actual = result[key as keyof typeof expected];
      expect(actual).not.toBeNull();
      const relative = Math.abs(actual! - value) / value;
      maxRelativeError = Math.max(maxRelativeError, relative);
      expect(relative).toBeLessThan(0.000001);
    }
    expect(scene.walls.map((w) => w.measuredLength)).toEqual([
      4.257, 3, 4.257, 3,
    ]);
  }
  expect(maxRelativeError).toBeLessThan(0.000001);
});
