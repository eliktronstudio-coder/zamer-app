import * as clipping from "polygon-clipping";
import type { Room, Point, ConstructionElement } from "../domain/model";
import type { GeometryScene } from "../geometry/constraints";
import {
  detectRooms,
  pointInRoom,
  type TopologyResult,
  type DetectedRoom,
} from "../geometry/rooms";
import {
  geometryArea,
  elementFootprint,
  calculateRoom,
  calculateFloor,
  type RoomQuantities,
  type FloorQuantities,
} from "./quantities";
import { distance, GEOMETRY_EPSILON as EPS } from "../geometry/primitives";
import { intersectSegments } from "../geometry/segments";
export const calculationDependencies = {
  topology: ["walls.start", "walls.end"],
  rooms: [
    "topology",
    "rooms.height",
    "rooms.name",
    "walls.measuredLength",
    "walls.height",
    "walls.thickness",
    "elements",
    "floor.defaultHeight",
  ],
  floor: ["rooms", "walls", "elements"],
} as const;
export interface CalculationResult {
  topology: TopologyResult;
  rooms: RoomQuantities[];
  floor: FloorQuantities;
}
export class CalculationEngine {
  private topologyKey = "";
  private topology: TopologyResult = { candidates: [], problems: [] };
  private previousScene: GeometryScene | null = null;
  private previousHeight = 0;
  private result: CalculationResult | null = null;
  evaluate(scene: GeometryScene, height: number): CalculationResult {
    if (
      scene === this.previousScene &&
      height === this.previousHeight &&
      this.result
    )
      return this.result;
    const key = JSON.stringify(
      scene.walls.map((w) => [w.id, w.floorId, w.start, w.end]),
    );
    if (key !== this.topologyKey) {
      this.topology = detectRooms(scene.walls);
      this.topologyKey = key;
    }
    const rooms = (scene.rooms ?? []).map((room) =>
        calculateRoom(room, scene, height),
      ),
      floor = calculateFloor(scene, rooms);
    floor.complete &&=
      !this.topology.problems.length &&
      this.topology.candidates.every((face) =>
        scene.rooms?.some(
          (r) => r.geometricallyClosed && r.sourceKey === face.sourceKey,
        ),
      );
    this.previousScene = scene;
    this.previousHeight = height;
    this.result = { topology: this.topology, rooms, floor };
    return this.result;
  }
}
function elementBelongs(
  e: ConstructionElement,
  face: DetectedRoom,
  scene: GeometryScene,
): boolean {
  if (e.floorId !== face.floorId) return false;
  if (e.kind === "opening")
    return face.edges.flat().some((edge) => {
      if (edge.wallId !== e.wallId) return false;
      const wall = scene.walls.find((w) => w.id === edge.wallId);
      if (!wall) return false;
      const length = distance(wall.start, wall.end);
      return (
        Math.min(Math.max(edge.from, edge.to) * length, e.offset + e.width) -
          Math.max(Math.min(edge.from, edge.to) * length, e.offset) >
        EPS
      );
    });
  if (e.kind === "levelChange")
    return (
      e.boundary.some((p) => pointInRoom(p, face)) ||
      e.boundary.slice(0, -1).some((p, i) =>
        face.boundary.some(
          (a, j) =>
            intersectSegments(
              { start: p, end: e.boundary[i + 1] },
              {
                start: a,
                end: face.boundary[(j + 1) % face.boundary.length],
              },
            ).kind !== "none",
        ),
      )
    );
  try {
    return (
      geometryArea(
        clipping.intersection(
          [face.boundary, ...face.holes].map((r) =>
            r.map((p) => [p.x, p.y] as [number, number]),
          ),
          elementFootprint(e),
        ),
      ) >
      EPS ** 2
    );
  } catch {
    return false;
  }
}
const sorted = (ids: string[]) => [...new Set(ids)].sort();
const sameIds = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify(sorted([...a])) === JSON.stringify(sorted([...b]));
function roomFingerprint(room: Room, scene: GeometryScene): string {
  const walls = scene.walls
    .filter((w) => room.wallIds.includes(w.id))
    .map((w) => [
      w.id,
      w.start,
      w.end,
      w.height,
      w.thickness,
      w.measuredLength,
    ]);
  const face = { ...room };
  const elements = (scene.elements ?? [])
    .filter((e) => elementBelongs(e, face, scene))
    .map((e) => ({ ...e, roomIds: [] }));
  return JSON.stringify([
    room.name,
    room.height,
    room.boundary,
    room.holes,
    walls,
    elements,
  ]);
}
export function reconcileRooms(
  scene: GeometryScene,
  defaultHeight: number,
  previous?: GeometryScene,
): GeometryScene {
  if (!scene.rooms?.length) return scene;
  const detected = detectRooms(scene.walls),
    used = new Set<string>();
  const rooms = scene.rooms.map((room) => {
    const face = detected.candidates.find(
      (face) =>
        face.sourceKey === room.sourceKey &&
        face.floorId === room.floorId &&
        !used.has(face.sourceKey),
    );
    if (face) used.add(face.sourceKey);
    let next: Room = face
      ? { ...room, ...face, geometricallyClosed: true }
      : { ...room, geometricallyClosed: false };
    const old = previous?.rooms?.find((r) => r.id === room.id);
    if (
      old &&
      (old.status === "completed" || old.status === "completedWithNotes") &&
      roomFingerprint(old, previous!) !== roomFingerprint(next, scene)
    )
      next = {
        ...next,
        status: calculateRoom(next, scene, defaultHeight).complete
          ? "inProgress"
          : "issues",
      };
    if (!next.geometricallyClosed && next.status !== "completedWithNotes")
      next = { ...next, status: "issues" };
    return JSON.stringify(next) === JSON.stringify(room) ? room : next;
  });
  const closed = rooms.filter((r) => r.geometricallyClosed);
  const walls = scene.walls.map((w) => {
    const ids = closed.filter((r) => r.wallIds.includes(w.id)).map((r) => r.id);
    return sameIds(w.roomIds, ids) ? w : { ...w, roomIds: sorted(ids) };
  });
  const elements = (scene.elements ?? []).map((e) => {
    const ids = closed
      .filter((r) => elementBelongs(e, r, scene))
      .map((r) => r.id);
    return sameIds(e.roomIds, ids) ? e : { ...e, roomIds: sorted(ids) };
  });
  const dimensions = scene.dimensions.map((d) => {
    const ids = sorted(
      walls
        .filter((w) => w.id === d.from.elementId || w.id === d.to.elementId)
        .flatMap((w) => w.roomIds),
    );
    return sameIds(d.roomIds, ids) ? d : { ...d, roomIds: ids };
  });
  return { ...scene, rooms, walls, elements, dimensions };
}
export function detectedAt(
  topology: TopologyResult,
  point: Point,
): DetectedRoom | undefined {
  return topology.candidates.find((room) => pointInRoom(point, room));
}
export function createRoom(
  face: DetectedRoom,
  name: string,
  height: number | null,
): Room {
  return {
    ...face,
    id: crypto.randomUUID(),
    name: name.trim(),
    height,
    geometricallyClosed: true,
    status: "inProgress",
  };
}
export function roomOpeningIds(room: Room, scene: GeometryScene): string[] {
  return (scene.elements ?? [])
    .filter(
      (e) =>
        e.kind === "opening" &&
        room.edges.flat().some((edge) => {
          if (edge.wallId !== e.wallId) return false;
          const wall = scene.walls.find((w) => w.id === edge.wallId);
          if (!wall) return false;
          const l = distance(wall.start, wall.end);
          return (
            Math.min(Math.max(edge.from, edge.to) * l, e.offset + e.width) -
              Math.max(Math.min(edge.from, edge.to) * l, e.offset) >
            EPS
          );
        }),
    )
    .map((e) => e.id);
}
