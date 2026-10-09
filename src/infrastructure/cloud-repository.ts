import type { ZamerDatabase } from "./database";
import type { ProjectSnapshot } from "../domain/model";
import { parseSnapshot } from "../domain/snapshot";
import { markCloudDirty } from "./sync-dirty";
import type { OutboxEntry } from "./sync-model";
export function cloudTables(db: ZamerDatabase) {
  return [
    db.projects,
    db.floors,
    db.walls,
    db.elements,
    db.rooms,
    db.dimensions,
    db.junctions,
    db.sceneRevisions,
    db.cloudStates,
    db.outbox,
    db.cloudConflicts,
    db.recoveryDrafts,
    db.defects,
    db.photos,
    db.photoFiles,
    db.photoTransfers,
  ];
}
export async function projectSnapshot(
  db: ZamerDatabase,
  id: string,
): Promise<ProjectSnapshot> {
  const project = await db.projects.get(id);
  if (!project) throw new Error("Объект не найден");
  const floors = await db.floors.where({ projectId: id }).sortBy("order"),
    ids = floors.map((f) => f.id);
  const rows = async (table: typeof db.walls) =>
    table.where("floorId").anyOf(ids).toArray();
  return parseSnapshot({
    schemaVersion: 5,
    geometrySchemaVersion: 4,
    exportSchemaVersion: 5,
    project,
    floors,
    defects: await db.defects.where({ projectId: id }).toArray(),
    photos: await db.photos.where({ projectId: id }).toArray(),
    walls: await rows(db.walls),
    elements: await db.elements.where("floorId").anyOf(ids).toArray(),
    rooms: await db.rooms.where("floorId").anyOf(ids).toArray(),
    dimensions: await db.dimensions.where("floorId").anyOf(ids).toArray(),
    junctions: await db.junctions.where("floorId").anyOf(ids).toArray(),
  });
}
export function cloneSnapshot(
  source: ProjectSnapshot,
  name: string,
): ProjectSnapshot {
  const all = [
      source.project,
      ...source.floors,
      ...source.walls,
      ...source.elements,
      ...source.rooms,
      ...source.dimensions,
      ...source.junctions,
      ...source.defects,
      ...source.photos,
    ],
    ids = new Map(all.map((e) => [e.id, crypto.randomUUID()]));
  const remap = (id: string) => ids.get(id) ?? id;
  const bind = <T extends { id: string; floorId: string; roomIds: string[] }>(
    e: T,
  ) => ({
    ...e,
    id: remap(e.id),
    floorId: remap(e.floorId),
    roomIds: e.roomIds.map(remap),
  });
  return parseSnapshot({
    ...source,
    project: {
      ...source.project,
      id: remap(source.project.id),
      ownerId: null,
      name: name.slice(0, 160),
      revision: 0,
      status: "active",
      deletedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    floors: source.floors.map((f) => ({
      ...f,
      id: remap(f.id),
      projectId: remap(f.projectId),
    })),
    walls: source.walls.map(bind),
    elements: source.elements.map((e) => ({
      ...bind(e),
      ...(e.kind === "opening" ? { wallId: remap(e.wallId) } : {}),
    })),
    rooms: source.rooms.map((r) => ({
      ...r,
      id: remap(r.id),
      floorId: remap(r.floorId),
      wallIds: r.wallIds.map(remap),
      sourceKey: r.wallIds.map(remap).sort().join(":"),
      edges: r.edges.map((loop) =>
        loop.map((e) => ({ ...e, wallId: remap(e.wallId) })),
      ),
    })),
    defects: source.defects.map((d) => ({
      ...d,
      id: remap(d.id),
      projectId: remap(d.projectId),
      floorId: d.floorId ? remap(d.floorId) : null,
      roomId: d.roomId ? remap(d.roomId) : null,
      elementId: d.elementId ? remap(d.elementId) : null,
    })),
    photos: source.photos.map((p) => ({
      ...p,
      id: remap(p.id),
      projectId: remap(p.projectId),
      floorId: p.floorId ? remap(p.floorId) : null,
      roomId: p.roomId ? remap(p.roomId) : null,
      elementId: p.elementId ? remap(p.elementId) : null,
      defectId: p.defectId ? remap(p.defectId) : null,
      storageKey: `${remap(p.projectId)}/${remap(p.id)}/${p.checksum}`,
    })),
    dimensions: source.dimensions.map((d) => ({
      ...bind(d),
      from: { ...d.from, elementId: remap(d.from.elementId) },
      to: { ...d.to, elementId: remap(d.to.elementId) },
    })),
    junctions: source.junctions.map((j) => ({
      ...j,
      id: remap(j.id),
      floorId: remap(j.floorId),
      endpoints: j.endpoints.map((e) => ({
        ...e,
        elementId: remap(e.elementId),
      })),
    })),
  });
}
async function writeSnapshot(db: ZamerDatabase, snapshot: ProjectSnapshot) {
  const s = parseSnapshot(snapshot),
    oldFloors = await db.floors.where({ projectId: s.project.id }).toArray(),
    oldIds = oldFloors.map((f) => f.id);
  for (const [table, entries] of [
    [db.walls, s.walls],
    [db.elements, s.elements],
    [db.rooms, s.rooms],
    [db.dimensions, s.dimensions],
    [db.junctions, s.junctions],
  ] as const) {
    for (const e of entries) {
      const old = await table.get(e.id);
      if (old && !oldIds.includes(old.floorId))
        throw new Error("Идентификатор занят в другом локальном объекте");
    }
    await table.where("floorId").anyOf(oldIds).delete();
  }
  for (const floor of s.floors) {
    const old = await db.floors.get(floor.id);
    if (old && old.projectId !== s.project.id)
      throw new Error("Этаж принадлежит другому объекту");
  }
  await db.floors.where({ projectId: s.project.id }).delete();
  await db.floors.bulkPut(s.floors);
  await db.walls.bulkPut(s.walls);
  await db.elements.bulkPut(s.elements);
  await db.rooms.bulkPut(s.rooms);
  await db.dimensions.bulkPut(s.dimensions);
  await db.junctions.bulkPut(s.junctions);
  for (const [table, entries] of [
    [db.defects, s.defects],
    [db.photos, s.photos],
  ] as const) {
    for (const e of entries) {
      const old = await table.get(e.id);
      if (old && old.projectId !== s.project.id)
        throw new Error("ID фото/дефекта занят");
    }
    await table.where({ projectId: s.project.id }).delete();
  }
  await db.defects.bulkPut(s.defects);
  await db.photos.bulkPut(s.photos);
  await db.projects.put(s.project);
  // Bump local CAS generations so a previously opened editor cannot overwrite a download.
  for (const f of s.floors)
    await db.sceneRevisions.put({
      floorId: f.id,
      revision: ((await db.sceneRevisions.get(f.id))?.revision ?? 0) + 1,
    });
}
export class CloudRepository {
  constructor(readonly db: ZamerDatabase) {}
  async enroll(id: string, ownerId: string) {
    return this.db.transaction("rw", cloudTables(this.db), async () => {
      this.assertOwner(ownerId);
      const p = await this.db.projects.get(id);
      if (!p || (p.ownerId !== null && p.ownerId !== ownerId))
        throw new Error("Объект недоступен");
      if (await this.db.cloudStates.get(id)) return;
      const owned = { ...p, ownerId, revision: p.revision + 1 };
      await this.db.projects.put(owned);
      await this.db.cloudStates.put({
        projectId: id,
        ownerId,
        baseRevision: 0,
        ackLocalRevision: -1,
        status: "pending",
        lastSyncedAt: null,
      });
      await markCloudDirty(this.db, owned);
    });
  }
  assertOwner(id: string) {
    if (this.db.currentOwnerId !== id) throw new Error("Аккаунт изменился");
  }
  async prepare(
    ownerId: string,
    now = Date.now(),
  ): Promise<OutboxEntry | undefined> {
    return this.db.transaction("rw", cloudTables(this.db), async () => {
      this.assertOwner(ownerId);
      const entries = await this.db.outbox.where({ ownerId }).toArray();
      for (const entry of entries.sort(
        (a, b) => a.localRevision - b.localRevision,
      )) {
        const state = await this.db.cloudStates.get(entry.projectId);
        if (!state || state.status === "conflict" || entry.nextAttemptAt > now)
          continue;
        const frozen = entries.find(
          (e) => e.projectId === entry.projectId && e.snapshot !== null,
        );
        if (frozen) {
          if (frozen.nextAttemptAt <= now) return frozen;
          continue;
        }
        const snapshot = await projectSnapshot(this.db, entry.projectId);
        if (snapshot.project.ownerId !== ownerId)
          throw new Error("Другой владелец");
        const ready = {
          ...entry,
          snapshot,
          localRevision: snapshot.project.revision,
          baseRevision: state.baseRevision,
        };
        await this.db.outbox.put(ready);
        await this.db.outbox.bulkDelete(
          entries
            .filter(
              (e) =>
                e.projectId === entry.projectId &&
                e.id !== ready.id &&
                e.snapshot === null &&
                e.localRevision <= ready.localRevision,
            )
            .map((e) => e.id),
        );
        return ready;
      }
    });
  }
  async ack(entry: OutboxEntry, revision: number) {
    return this.db.transaction(
      "rw",
      [this.db.cloudStates, this.db.outbox],
      async () => {
        this.assertOwner(entry.ownerId);
        const stored = await this.db.outbox.get(entry.id),
          state = await this.db.cloudStates.get(entry.projectId);
        if (!stored || !state) return;
        if (!Number.isSafeInteger(revision) || revision <= entry.baseRevision)
          throw new Error("Некорректный ACK");
        await this.db.outbox.delete(entry.id);
        const more = await this.db.outbox
          .where({ projectId: entry.projectId })
          .count();
        await this.db.cloudStates.put({
          ...state,
          baseRevision: revision,
          ackLocalRevision: entry.localRevision,
          status: more ? "pending" : "synced",
          lastSyncedAt: new Date().toISOString(),
        });
      },
    );
  }
  async failed(entry: OutboxEntry, error: string, now = Date.now()) {
    this.assertOwner(entry.ownerId);
    const attempts = entry.attempts + 1;
    await this.db.outbox.update(entry.id, {
      attempts,
      error,
      nextAttemptAt: now + Math.min(300000, 1000 * 2 ** Math.min(attempts, 8)),
    });
  }
  async conflict(
    entry: OutboxEntry,
    remote: ProjectSnapshot,
    revision: number,
  ) {
    return this.db.transaction("rw", cloudTables(this.db), async () => {
      this.assertOwner(entry.ownerId);
      if (!Number.isSafeInteger(revision) || revision <= entry.baseRevision)
        throw new Error("Некорректная облачная ревизия");
      const s = parseSnapshot(remote);
      if (
        s.project.ownerId !== entry.ownerId ||
        s.project.id !== entry.projectId
      )
        throw new Error("Ответ другого объекта или владельца");
      await this.db.cloudConflicts.put({
        projectId: entry.projectId,
        ownerId: entry.ownerId,
        local: await projectSnapshot(this.db, entry.projectId),
        remote: s,
        remoteRevision: revision,
        createdAt: new Date().toISOString(),
      });
      const state = await this.db.cloudStates.get(entry.projectId);
      if (state)
        await this.db.cloudStates.put({ ...state, status: "conflict" });
    });
  }
  async download(raw: ProjectSnapshot, revision: number, ownerId: string) {
    return this.db.transaction("rw", cloudTables(this.db), async () => {
      this.assertOwner(ownerId);
      const s = parseSnapshot(raw);
      if (
        s.project.ownerId !== ownerId ||
        !Number.isSafeInteger(revision) ||
        revision < 1
      )
        throw new Error("Некорректный облачный объект");
      const local = await this.db.projects.get(s.project.id),
        state = await this.db.cloudStates.get(s.project.id);
      if (local) {
        if (local.ownerId !== ownerId)
          throw new Error("Облачный ID занят локальным объектом");
        if (state && revision <= state.baseRevision) return;
        await this.db.cloudConflicts.put({
          projectId: s.project.id,
          ownerId,
          local: await projectSnapshot(this.db, s.project.id),
          remote: s,
          remoteRevision: revision,
          createdAt: new Date().toISOString(),
        });
        await this.db.cloudStates.put({
          projectId: s.project.id,
          ownerId,
          baseRevision: state?.baseRevision ?? 0,
          ackLocalRevision: state?.ackLocalRevision ?? -1,
          status: "conflict",
          lastSyncedAt: state?.lastSyncedAt ?? null,
        });
        return;
      }
      await writeSnapshot(this.db, s);
      await this.db.cloudStates.put({
        projectId: s.project.id,
        ownerId,
        baseRevision: revision,
        ackLocalRevision: s.project.revision,
        status: "synced",
        lastSyncedAt: new Date().toISOString(),
      });
    });
  }
  async resolve(id: string, ownerId: string, acceptRemote: boolean) {
    return this.db.transaction("rw", cloudTables(this.db), async () => {
      this.assertOwner(ownerId);
      const conflict = await this.db.cloudConflicts.get(id);
      if (!conflict || conflict.ownerId !== ownerId)
        throw new Error("Конфликт недоступен");
      if (acceptRemote) {
        const floors = await this.db.floors.where({ projectId: id }).toArray();
        if (
          await this.db.recoveryDrafts
            .where("floorId")
            .anyOf(floors.map((f) => f.id))
            .count()
        )
          throw new Error("Сначала восстановите резервные копии этажей");
      }
      const local = await projectSnapshot(this.db, id),
        copy = cloneSnapshot(local, `${local.project.name} (локальная копия)`);
      for (const p of local.photos)
        if (!(await this.db.photoFiles.get(p.checksum)))
          throw new Error(
            "Сначала загрузите оригиналы фото для локальной копии",
          );
      await writeSnapshot(this.db, copy);
      if (acceptRemote) {
        await writeSnapshot(this.db, conflict.remote);
        await this.db.outbox.where({ projectId: id }).delete();
        await this.db.cloudConflicts.delete(id);
        await this.db.cloudStates.put({
          projectId: id,
          ownerId,
          baseRevision: conflict.remoteRevision,
          ackLocalRevision: conflict.remote.project.revision,
          status: "synced",
          lastSyncedAt: new Date().toISOString(),
        });
      }
      return copy.project.id;
    });
  }
}
