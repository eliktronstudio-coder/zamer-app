import { assertRoomContours } from "../geometry/rooms";
import { parseElement } from "../geometry/elements";
import {
  snapshotSchema,
  snapshotV1Schema,
  snapshotV2Schema,
  snapshotV3Schema,
  snapshotV4Schema,
  type ProjectSnapshot,
} from "./model";
export function parseSnapshot(input: unknown): ProjectSnapshot {
  const version =
    typeof input === "object" && input !== null && "schemaVersion" in input
      ? input.schemaVersion
      : undefined;
  const snapshot =
    version === 1
      ? snapshotSchema.parse({
          ...snapshotV1Schema.parse(input),
          schemaVersion: 5,
          geometrySchemaVersion: 4,
          exportSchemaVersion: 5,
          junctions: [],
          dimensions: [],
          elements: [],
          rooms: [],
          defects: [],
          photos: [],
        })
      : version === 2
        ? snapshotSchema.parse({
            ...snapshotV2Schema.parse(input),
            schemaVersion: 5,
            geometrySchemaVersion: 4,
            exportSchemaVersion: 5,
            elements: [],
            rooms: [],
            defects: [],
            photos: [],
          })
        : version === 3
          ? snapshotSchema.parse({
              ...snapshotV3Schema.parse(input),
              schemaVersion: 5,
              geometrySchemaVersion: 4,
              exportSchemaVersion: 5,
              rooms: [],
              defects: [],
              photos: [],
            })
          : version === 4
            ? snapshotSchema.parse({
                ...snapshotV4Schema.parse(input),
                schemaVersion: 5,
                exportSchemaVersion: 5,
                defects: [],
                photos: [],
              })
            : snapshotSchema.parse(input);
  const ids = [
    snapshot.project.id,
    ...snapshot.floors.map((f) => f.id),
    ...snapshot.walls.map((w) => w.id),
    ...snapshot.junctions.map((j) => j.id),
    ...snapshot.dimensions.map((d) => d.id),
    ...snapshot.elements.map((e) => e.id),
    ...snapshot.rooms.map((r) => r.id),
    ...snapshot.defects.map((d) => d.id),
    ...snapshot.photos.map((p) => p.id),
  ];
  if (new Set(ids).size !== ids.length)
    throw new Error("Повторяющиеся идентификаторы");
  if (snapshot.floors.some((f) => f.projectId !== snapshot.project.id))
    throw new Error("Этаж относится к другому проекту");
  const floors = new Set(snapshot.floors.map((f) => f.id));
  if (snapshot.walls.some((w) => !floors.has(w.floorId)))
    throw new Error("Стена ссылается на отсутствующий этаж");
  const walls = new Map(snapshot.walls.map((w) => [w.id, w]));
  const endpoints = new Set<string>();
  for (const junction of snapshot.junctions) {
    if (!floors.has(junction.floorId))
      throw new Error("Связь ссылается на отсутствующий этаж");
    for (const reference of junction.endpoints) {
      const wall = walls.get(reference.elementId),
        key = `${reference.elementId}:${reference.anchor}`;
      if (!wall || wall.floorId !== junction.floorId)
        throw new Error("Некорректная связь концов стен");
      if (endpoints.has(key)) throw new Error("Повторная связь конца стены");
      endpoints.add(key);
    }
  }
  for (const dimension of snapshot.dimensions) {
    if (
      !floors.has(dimension.floorId) ||
      [dimension.from, dimension.to].some(
        (r) => walls.get(r.elementId)?.floorId !== dimension.floorId,
      )
    )
      throw new Error("Размер потерял связь со стеной");
  }
  for (const element of snapshot.elements) {
    parseElement(element);
    if (
      !floors.has(element.floorId) ||
      (element.kind === "opening" &&
        walls.get(element.wallId)?.floorId !== element.floorId)
    )
      throw new Error("Строительный элемент потерял связь с этажом или стеной");
  }
  for (const room of snapshot.rooms) {
    if (!floors.has(room.floorId))
      throw new Error("Помещение относится к отсутствующему этажу");
    if (
      room.geometricallyClosed &&
      room.wallIds.some((id) => walls.get(id)?.floorId !== room.floorId)
    )
      throw new Error("Замкнутое помещение потеряло связь со стенами");
  }
  const rooms = new Map(snapshot.rooms.map((r) => [r.id, r]));
  for (const entry of [
    ...snapshot.walls,
    ...snapshot.dimensions,
    ...snapshot.elements,
  ])
    if (entry.roomIds.some((id) => rooms.get(id)?.floorId !== entry.floorId))
      throw new Error("Элемент ссылается на отсутствующее помещение");
  const defects = new Map(snapshot.defects.map((d) => [d.id, d]));
  for (const entry of [...snapshot.defects, ...snapshot.photos]) {
    if (
      entry.projectId !== snapshot.project.id ||
      (entry.floorId !== null && !floors.has(entry.floorId))
    )
      throw new Error("Некорректная привязка дефекта или фото");
    if (
      entry.roomId &&
      rooms.has(entry.roomId) &&
      rooms.get(entry.roomId)!.floorId !== entry.floorId
    )
      throw new Error("Помещение другого этажа");
  }
  for (const photo of snapshot.photos) {
    if (photo.defectId && !defects.has(photo.defectId))
      throw new Error("Фото потеряло дефект");
    const d = photo.defectId ? defects.get(photo.defectId) : null;
    if (
      d &&
      (d.floorId !== photo.floorId ||
        d.roomId !== photo.roomId ||
        d.elementId !== photo.elementId)
    )
      throw new Error("Фото не соответствует привязкам дефекта");
    if (photo.storageKey !== `${photo.projectId}/${photo.id}/${photo.checksum}`)
      throw new Error("Некорректный путь оригинала");
  }
  assertRoomContours(snapshot.rooms, snapshot.walls);
  return snapshot;
}
export function serializeSnapshot(snapshot: ProjectSnapshot): string {
  return JSON.stringify(parseSnapshot(snapshot), null, 2);
}
