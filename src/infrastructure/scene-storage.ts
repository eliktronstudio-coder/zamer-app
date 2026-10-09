import { markCloudDirty } from "./sync-dirty";
import { assertRoomContours } from "../geometry/rooms";
import { parseElement } from "../geometry/elements";
import {
  roomSchema,
  dimensionSchema,
  junctionSchema,
  wallSchema,
  type Floor,
  type Project,
} from "../domain/model";
import type { GeometryScene } from "../geometry/constraints";
import { validateScene } from "../geometry/constraints";
import type { ZamerDatabase } from "./database";

export interface SceneRevision {
  floorId: string;
  revision: number;
}
export interface RecoveryDraft {
  id: string;
  floorId: string;
  scene: GeometryScene;
  updatedAt: string;
}
export class SceneConflictError extends Error {
  constructor() {
    super("План изменён в другой вкладке.");
    this.name = "SceneConflictError";
  }
}
export function parseFloorScene(
  scene: GeometryScene,
  floorId: string,
): GeometryScene {
  const parsed = {
    rooms: (scene.rooms ?? []).map((r) => roomSchema.parse(r)),
    elements: (scene.elements ?? []).map(parseElement),
    walls: scene.walls.map((w) => wallSchema.parse(w)),
    junctions: scene.junctions.map((j) => junctionSchema.parse(j)),
    dimensions: scene.dimensions.map((d) => dimensionSchema.parse(d)),
  };
  if (
    [
      ...parsed.walls,
      ...parsed.junctions,
      ...parsed.dimensions,
      ...parsed.elements,
      ...parsed.rooms,
    ].some((e) => e.floorId !== floorId)
  )
    throw new Error("Элемент относится к другому этажу");
  const all = [
    ...parsed.walls,
    ...parsed.junctions,
    ...parsed.dimensions,
    ...parsed.elements,
    ...parsed.rooms,
  ];
  if (new Set(all.map((e) => e.id)).size !== all.length)
    throw new Error("Повторяющиеся идентификаторы");
  if (
    parsed.elements.some(
      (e) =>
        e.kind === "opening" && !parsed.walls.some((w) => w.id === e.wallId),
    )
  )
    throw new Error("Проём потерял связь со стеной");
  const rooms = new Map(parsed.rooms.map((r) => [r.id, r]));
  for (const entity of [
    ...parsed.walls,
    ...parsed.dimensions,
    ...parsed.elements,
  ])
    if (entity.roomIds.some((id) => rooms.get(id)?.floorId !== floorId))
      throw new Error("Элемент потерял связь с помещением");
  for (const room of parsed.rooms)
    if (
      room.geometricallyClosed &&
      room.wallIds.some((id) => !parsed.walls.some((w) => w.id === id))
    )
      throw new Error("Помещение потеряло связь со стеной");
  const unsafe = validateScene(parsed).filter((p) =>
    [
      "invalid-model",
      "duplicate-id",
      "duplicate-endpoint",
      "wrong-floor",
    ].includes(p.code),
  );
  if (unsafe.length) throw new Error("Некорректные связи модели");
  assertRoomContours(parsed.rooms, parsed.walls);
  return parsed;
}
export class SceneRepository {
  constructor(readonly db: ZamerDatabase) {}
  async load(floorId: string) {
    return this.db.transaction(
      "r",
      [
        this.db.floors,
        this.db.projects,
        this.db.rooms,
        this.db.elements,
        this.db.walls,
        this.db.junctions,
        this.db.dimensions,
        this.db.sceneRevisions,
      ],
      async () => {
        const floor = await this.db.floors.get(floorId);
        const project = floor
          ? await this.db.projects.get(floor.projectId)
          : undefined;
        if (
          !floor ||
          !project ||
          (project.ownerId !== null &&
            project.ownerId !== this.db.currentOwnerId)
        )
          throw new Error("Этаж недоступен этому аккаунту");
        const scene = parseFloorScene(
          {
            rooms: await this.db.rooms.where({ floorId }).toArray(),
            elements: await this.db.elements.where({ floorId }).toArray(),
            walls: await this.db.walls.where({ floorId }).toArray(),
            junctions: await this.db.junctions.where({ floorId }).toArray(),
            dimensions: await this.db.dimensions.where({ floorId }).toArray(),
          },
          floorId,
        );
        return {
          scene,
          revision: (await this.db.sceneRevisions.get(floorId))?.revision ?? 0,
        };
      },
    );
  }
  async save(
    floorId: string,
    scene: GeometryScene,
    expectedRevision: number,
    recoveryId?: string,
  ): Promise<number> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0)
      throw new RangeError("Некорректная версия плана");
    const parsed = parseFloorScene(scene, floorId);
    return this.db.transaction(
      "rw",
      [
        this.db.projects,
        this.db.cloudStates,
        this.db.outbox,
        this.db.floors,
        this.db.rooms,
        this.db.elements,
        this.db.walls,
        this.db.junctions,
        this.db.dimensions,
        this.db.sceneRevisions,
        this.db.recoveryDrafts,
      ],
      async () => {
        const floor = await this.db.floors.get(floorId),
          project = floor
            ? await this.db.projects.get(floor.projectId)
            : undefined;
        if (
          !floor ||
          !project ||
          project.status !== "active" ||
          (project.ownerId !== null &&
            project.ownerId !== this.db.currentOwnerId)
        )
          throw new Error("Объект недоступен");
        const revision =
          (await this.db.sceneRevisions.get(floorId))?.revision ?? 0;
        if (revision !== expectedRevision) throw new SceneConflictError();
        // Never overwrite globally keyed entities belonging to another floor.
        for (const [table, entries] of [
          [this.db.rooms, parsed.rooms ?? []],
          [this.db.elements, parsed.elements ?? []],
          [this.db.walls, parsed.walls],
          [this.db.junctions, parsed.junctions],
          [this.db.dimensions, parsed.dimensions],
        ] as const) {
          for (const entry of entries) {
            const existing = await table.get(entry.id);
            if (existing && existing.floorId !== floorId)
              throw new Error("Идентификатор занят на другом этаже");
          }
          await table.where({ floorId }).delete();
        }
        await this.db.rooms.bulkPut([...(parsed.rooms ?? [])]);
        await this.db.elements.bulkPut([...(parsed.elements ?? [])]);
        await this.db.walls.bulkPut(parsed.walls);
        await this.db.junctions.bulkPut(parsed.junctions);
        await this.db.dimensions.bulkPut(parsed.dimensions);
        await this.db.sceneRevisions.put({ floorId, revision: revision + 1 });
        await this.db.projects.put({
          ...project,
          revision: project.revision + 1,
          updatedAt: new Date().toISOString(),
        });
        await markCloudDirty(
          this.db,
          (await this.db.projects.get(project.id))!,
        );
        if (recoveryId) {
          const draft = await this.db.recoveryDrafts.get(recoveryId);
          if (draft && draft.floorId !== floorId)
            throw new Error("Копия относится к другому этажу");
          await this.db.recoveryDrafts.delete(recoveryId);
        }
        return revision + 1;
      },
    );
  }
  async backup(id: string, floorId: string, scene: GeometryScene) {
    await this.db.recoveryDrafts.put({
      id,
      floorId,
      scene: parseFloorScene(scene, floorId),
      updatedAt: new Date().toISOString(),
    });
  }
  async drafts(floorId: string) {
    return this.db.recoveryDrafts.where({ floorId }).toArray();
  }
  async recover(id: string): Promise<Floor> {
    return this.db.transaction(
      "rw",
      [
        this.db.projects,
        this.db.cloudStates,
        this.db.outbox,
        this.db.floors,
        this.db.rooms,
        this.db.elements,
        this.db.walls,
        this.db.junctions,
        this.db.dimensions,
        this.db.sceneRevisions,
        this.db.recoveryDrafts,
      ],
      async () => {
        const draft = await this.db.recoveryDrafts.get(id),
          source = draft ? await this.db.floors.get(draft.floorId) : undefined;
        const project: Project | undefined = source
          ? await this.db.projects.get(source.projectId)
          : undefined;
        if (
          !draft ||
          !source ||
          !project ||
          project.status !== "active" ||
          (project.ownerId !== null &&
            project.ownerId !== this.db.currentOwnerId)
        )
          throw new Error("Копия недоступна");
        const floors = await this.db.floors
          .where({ projectId: source.projectId })
          .toArray();
        const floor: Floor = {
          ...source,
          id: crypto.randomUUID(),
          name: `${source.name.slice(0, 55)} (восстановлено)`,
          order: Math.max(-1, ...floors.map((f) => f.order)) + 1,
        };
        const ids = new Map(
          [
            ...(draft.scene.rooms ?? []),
            ...(draft.scene.elements ?? []),
            ...draft.scene.walls,
            ...draft.scene.dimensions,
            ...draft.scene.junctions,
          ].map((e) => [e.id, crypto.randomUUID()]),
        );
        const remap = (reference: {
          elementId: string;
          anchor: "start" | "end" | "center";
        }) => ({
          ...reference,
          elementId: ids.get(reference.elementId) ?? reference.elementId,
        });
        const roomIds = (idsList: string[]) =>
          idsList.map((id) => ids.get(id) ?? id);
        const scene: GeometryScene = {
          rooms: (draft.scene.rooms ?? []).map((r) => ({
            ...r,
            id: ids.get(r.id)!,
            floorId: floor.id,
            wallIds: roomIds(r.wallIds),
            sourceKey: roomIds(r.wallIds).sort().join(":"),
            edges: r.edges.map((loop) =>
              loop.map((edge) => ({
                ...edge,
                wallId: ids.get(edge.wallId) ?? edge.wallId,
              })),
            ),
          })),
          elements: (draft.scene.elements ?? []).map((e) => ({
            ...e,
            id: ids.get(e.id)!,
            floorId: floor.id,
            roomIds: roomIds(e.roomIds),
            ...(e.kind === "opening"
              ? { wallId: ids.get(e.wallId) ?? e.wallId }
              : {}),
          })),
          walls: draft.scene.walls.map((w) => ({
            ...w,
            id: ids.get(w.id)!,
            floorId: floor.id,
            roomIds: roomIds(w.roomIds),
          })),
          dimensions: draft.scene.dimensions.map((d) => ({
            ...d,
            id: ids.get(d.id)!,
            floorId: floor.id,
            roomIds: roomIds(d.roomIds),
            from: remap(d.from),
            to: remap(d.to),
          })),
          junctions: draft.scene.junctions.map((j) => ({
            ...j,
            id: ids.get(j.id)!,
            floorId: floor.id,
            endpoints: j.endpoints.map((r) => ({
              ...r,
              elementId: ids.get(r.elementId) ?? r.elementId,
            })),
          })),
        };
        parseFloorScene(scene, floor.id);
        await this.db.floors.add(floor);
        await this.db.rooms.bulkPut([...(scene.rooms ?? [])]);
        await this.db.elements.bulkPut([...(scene.elements ?? [])]);
        await this.db.walls.bulkPut([...scene.walls]);
        await this.db.dimensions.bulkPut([...scene.dimensions]);
        await this.db.junctions.bulkPut([...scene.junctions]);
        await this.db.sceneRevisions.put({ floorId: floor.id, revision: 1 });
        await this.db.projects.put({
          ...project,
          revision: project.revision + 1,
          updatedAt: new Date().toISOString(),
        });
        await markCloudDirty(
          this.db,
          (await this.db.projects.get(project.id))!,
        );
        await this.db.recoveryDrafts.delete(id);
        return floor;
      },
    );
  }
}
