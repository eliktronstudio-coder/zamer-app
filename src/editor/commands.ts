import { wallSchema } from "../domain/model";
import type {
  Dimension,
  EndpointReference,
  Point,
  Wall,
} from "../domain/model";
import {
  applyDrivingDimension,
  type GeometryScene,
  type GeometryCommandResult,
} from "../geometry/constraints";
import { distance, GEOMETRY_EPSILON } from "../geometry/primitives";
import type { SnapCandidate } from "../geometry/snapping";
export function endpointFromSnap(
  scene: GeometryScene,
  candidate: SnapCandidate | null,
): EndpointReference | undefined {
  if (!candidate || !["start", "end", "linked"].includes(candidate.kind))
    return;
  for (const id of candidate.elementIds) {
    const wall = scene.walls.find((w) => w.id === id);
    if (!wall) continue;
    for (const anchor of ["start", "end"] as const)
      if (distance(wall[anchor], candidate.point) <= GEOMETRY_EPSILON)
        return { elementId: id, anchor };
  }
}
function attach(
  scene: GeometryScene,
  a: EndpointReference,
  b: EndpointReference,
): GeometryScene {
  const index = scene.junctions.findIndex((j) =>
    j.endpoints.some(
      (r) => r.elementId === a.elementId && r.anchor === a.anchor,
    ),
  );
  if (index >= 0)
    return {
      ...scene,
      junctions: scene.junctions.map((j, i) =>
        i === index ? { ...j, endpoints: [...j.endpoints, b] } : j,
      ),
    };
  const floorId = scene.walls.find((w) => w.id === b.elementId)!.floorId;
  return {
    ...scene,
    junctions: [
      ...scene.junctions,
      { id: crypto.randomUUID(), floorId, endpoints: [a, b] },
    ],
  };
}
export function addWall(
  scene: GeometryScene,
  wall: Wall,
  startLink?: EndpointReference,
  endLink?: EndpointReference,
): GeometryScene {
  const dimension: Dimension = {
    id: crypto.randomUUID(),
    floorId: wall.floorId,
    roomIds: [],
    metadata: {},
    kind: "dimension",
    mode: "driving",
    from: { elementId: wall.id, anchor: "start" },
    to: { elementId: wall.id, anchor: "end" },
    offset: 0.35,
    inputValue: wall.measuredLength,
  };
  let next: GeometryScene = {
    ...scene,
    walls: [...scene.walls, wall],
    dimensions: [...scene.dimensions, dimension],
  };
  if (startLink)
    next = attach(next, startLink, { elementId: wall.id, anchor: "start" });
  if (endLink)
    next = attach(next, endLink, { elementId: wall.id, anchor: "end" });
  return next;
}
export function addReferenceDimension(
  scene: GeometryScene,
  wall: Wall,
): GeometryScene {
  return {
    ...scene,
    dimensions: [
      ...scene.dimensions,
      {
        id: crypto.randomUUID(),
        floorId: wall.floorId,
        roomIds: [],
        metadata: {},
        kind: "dimension",
        mode: "reference",
        from: { elementId: wall.id, anchor: "start" },
        to: { elementId: wall.id, anchor: "end" },
        offset: 0.7,
        inputValue: null,
      },
    ],
  };
}
export function deleteElement(scene: GeometryScene, id: string): GeometryScene {
  if (scene.rooms?.some((r) => r.id === id))
    return {
      ...scene,
      rooms: scene.rooms.filter((r) => r.id !== id),
      walls: scene.walls.map((w) => ({
        ...w,
        roomIds: w.roomIds.filter((r) => r !== id),
      })),
      elements: (scene.elements ?? []).map((e) => ({
        ...e,
        roomIds: e.roomIds.filter((r) => r !== id),
      })),
      dimensions: scene.dimensions.map((d) => ({
        ...d,
        roomIds: d.roomIds.filter((r) => r !== id),
      })),
    };
  if (scene.walls.some((w) => w.id === id))
    return {
      ...scene,
      elements: (scene.elements ?? []).filter(
        (e) => e.kind !== "opening" || e.wallId !== id,
      ),
      walls: scene.walls.filter((w) => w.id !== id),
      dimensions: scene.dimensions.filter(
        (d) => d.from.elementId !== id && d.to.elementId !== id,
      ),
      junctions: scene.junctions
        .map((j) => ({
          ...j,
          endpoints: j.endpoints.filter((r) => r.elementId !== id),
        }))
        .filter((j) => j.endpoints.length >= 2),
    };
  return {
    ...scene,
    elements: (scene.elements ?? []).filter((e) => e.id !== id),
    dimensions: scene.dimensions.filter((d) => d.id !== id),
  };
}
export function dimensionLayout(from: Point, to: Point, offset: number) {
  const length = distance(from, to),
    normal = length
      ? { x: -(to.y - from.y) / length, y: (to.x - from.x) / length }
      : { x: 0, y: 1 };
  const a = { x: from.x + normal.x * offset, y: from.y + normal.y * offset },
    b = { x: to.x + normal.x * offset, y: to.y + normal.y * offset };
  return { a, b, center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

export function updateWallProperties(
  scene: GeometryScene,
  id: string,
  values: { length: number; thickness: number; height: number },
): GeometryCommandResult {
  const wall = scene.walls.find((w) => w.id === id);
  if (!wall)
    return {
      ok: false,
      problems: [
        {
          code: "missing-element",
          elementIds: [id],
          message: "Стена не найдена",
        },
      ],
    };
  wallSchema.parse({
    ...wall,
    thickness: values.thickness,
    height: values.height,
  });
  let driving = scene.dimensions.find(
    (d) =>
      d.mode === "driving" && d.from.elementId === id && d.to.elementId === id,
  );
  let base = scene;
  if (!driving) {
    driving = {
      id: crypto.randomUUID(),
      floorId: wall.floorId,
      kind: "dimension",
      roomIds: [],
      metadata: {},
      mode: "driving",
      from: { elementId: id, anchor: "start" },
      to: { elementId: id, anchor: "end" },
      offset: 0.35,
      inputValue: null,
    };
    base = { ...scene, dimensions: [...scene.dimensions, driving] };
  }
  const result = applyDrivingDimension(base, driving.id, values.length);
  if (!result.ok) return result;
  return {
    ...result,
    scene: {
      ...result.scene,
      walls: result.scene.walls.map((w) =>
        w.id === id
          ? { ...w, thickness: values.thickness, height: values.height }
          : w,
      ),
    },
  };
}
