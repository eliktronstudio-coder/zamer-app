import type { ProjectSnapshot } from "../../src/domain/model";
import { detectRooms } from "../../src/geometry/rooms";
import { createRoom } from "../../src/calculation/engine";
import { uuid, wall } from "../geometry/fixtures";
export function betaSnapshot(): ProjectSnapshot {
  const now = "2026-10-08T00:00:00.000Z";
  const projectId = uuid(900000);
  const floors = Array.from({ length: 20 }, (_, order) => ({
    id: uuid(900001 + order),
    projectId,
    name: `Этаж ${order + 1}`,
    elevation: order * 3,
    defaultHeight: 2.7,
    order,
  }));
  const walls = [],
    rooms = [];
  for (const floor of floors) {
    const floorWalls = [];
    for (let r = 0; r < 10; r++) {
      const x = (r % 5) * 8,
        y = Math.floor(r / 5) * 8;
      const corners = [
        { x, y },
        { x: x + 4.257, y },
        { x: x + 4.257, y: y + 3 },
        { x, y: y + 3 },
      ];
      const rectangle = corners.map((p, i) =>
        wall(
          10000 + floor.order * 250 + floorWalls.length + i,
          p,
          corners[(i + 1) % 4],
          { floorId: floor.id, measuredLength: i % 2 === 0 ? 4.257 : 3 },
        ),
      );
      const room = {
        ...createRoom(
          detectRooms(rectangle).candidates[0],
          `Замер ${r + 1}`,
          null,
        ),
        id: uuid(20000 + floor.order * 10 + r),
      };
      rectangle.forEach((w) => (w.roomIds = [room.id]));
      rooms.push(room);
      floorWalls.push(...rectangle);
    }
    for (let i = 0; i < 210; i++) {
      const x = 100 + (i % 30) * 8,
        y = Math.floor(i / 30) * 8;
      floorWalls.push(
        wall(
          10000 + floor.order * 250 + floorWalls.length,
          { x, y },
          { x: x + 4.257, y },
          { floorId: floor.id, measuredLength: 4.257 },
        ),
      );
    }
    walls.push(...floorWalls);
  }
  const defects = Array.from({ length: 1000 }, (_, i) => ({
    id: uuid(30000 + i),
    projectId,
    floorId: floors[i % 20].id,
    roomId: null,
    elementId: null,
    type: "Трещина",
    description: `Замер ${i + 1}`,
    position: { x: (i % 50) * 8, y: Math.floor(i / 50) * 8 },
    boundary: [],
    surface: "Стена",
    length: 0.123,
    width: null,
    depth: null,
    comment: "",
    recommendedWork: "Ремонт трещины",
    status: "open" as const,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }));
  return {
    schemaVersion: 5,
    geometrySchemaVersion: 4,
    exportSchemaVersion: 5,
    project: {
      id: projectId,
      name: "Beta · 5000 элементов",
      ownerId: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      revision: 0,
    },
    floors,
    walls,
    rooms,
    elements: [],
    junctions: [],
    dimensions: [
      {
        id: uuid(40000),
        floorId: floors[0].id,
        kind: "dimension",
        roomIds: [rooms[0].id],
        metadata: {},
        mode: "reference",
        from: { elementId: walls[0].id, anchor: "start" },
        to: { elementId: walls[0].id, anchor: "end" },
        offset: 0.4,
        inputValue: null,
      },
    ],
    defects,
    photos: [],
  };
}
