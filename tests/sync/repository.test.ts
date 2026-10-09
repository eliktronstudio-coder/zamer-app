import Dexie from "dexie";
import { describe, it, expect, afterEach } from "vitest";
import {
  ZamerDatabase,
  ProjectRepository,
} from "../../src/infrastructure/database";
import { SceneRepository } from "../../src/infrastructure/scene-storage";
import {
  CloudRepository,
  projectSnapshot,
  cloudTables,
  cloneSnapshot,
} from "../../src/infrastructure/cloud-repository";
import {
  SyncWorker,
  type SyncTransport,
} from "../../src/infrastructure/sync-worker";
import { uuid, wall, scene, dimension, junction } from "../geometry/fixtures";
const databases: ZamerDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete();
});
async function setup() {
  const db = new ZamerDatabase(`sync-${crypto.randomUUID()}`);
  databases.push(db);
  db.currentOwnerId = uuid(900);
  const projects = new ProjectRepository(db),
    data = await projects.create("Замер", "Первый"),
    cloud = new CloudRepository(db),
    scenes = new SceneRepository(db);
  return { db, projects, cloud, scenes, ...data, ownerId: uuid(900) };
}
async function snapshot(db: ZamerDatabase, id: string) {
  return db.transaction("r", cloudTables(db), () => projectSnapshot(db, id));
}
describe("transactional sync", () => {
  it("guests remain local until explicit enrollment and outbox survives reopen", async () => {
    const { db, cloud, project, ownerId } = await setup();
    expect(await db.outbox.count()).toBe(0);
    await cloud.enroll(project.id, ownerId);
    expect(await db.outbox.count()).toBe(1);
    db.close();
    await db.open();
    expect((await cloud.prepare(ownerId))!.snapshot!.project.ownerId).toBe(
      ownerId,
    );
  });
  it("local edits and queue markers roll back together on storage failure", async () => {
    const { db, cloud, project, ownerId, projects } = await setup();
    await cloud.enroll(project.id, ownerId);
    const count = await db.outbox.count(),
      original = await db.projects.get(project.id);
    db.outbox.hook("creating", () => {
      throw new Error("quota");
    });
    await expect(projects.rename(project.id, "Изменение")).rejects.toThrow(
      "quota",
    );
    expect(await db.projects.get(project.id)).toEqual(original);
    expect(await db.outbox.count()).toBe(count);
  });
  it("scene save, floor creation and project status all produce durable commands", async () => {
    const { db, cloud, project, ownerId, projects, scenes, floor } =
      await setup();
    await cloud.enroll(project.id, ownerId);
    await scenes.save(
      floor.id,
      scene([wall(1, undefined, undefined, { floorId: floor.id })]),
      0,
    );
    await projects.addFloor(project.id, "Второй");
    await projects.status(project.id, "archived");
    expect(await db.outbox.count()).toBe(4);
    const entry = await cloud.prepare(ownerId);
    expect(entry!.snapshot!.floors).toHaveLength(2);
    expect(entry!.snapshot!.walls).toHaveLength(1);
    expect(entry!.snapshot!.project.status).toBe("archived");
    expect(await db.outbox.count()).toBe(1);
  });
  it("freezes in-flight payload and ACK never discards newer local edits", async () => {
    const { db, cloud, project, ownerId, projects } = await setup();
    await cloud.enroll(project.id, ownerId);
    const first = (await cloud.prepare(ownerId))!;
    await projects.rename(project.id, "Новый замер");
    const again = (await cloud.prepare(ownerId))!;
    expect(again).toEqual(first);
    await cloud.ack(first, 1);
    expect((await db.cloudStates.get(project.id))!.status).toBe("pending");
    expect(await db.outbox.count()).toBe(1);
    const next = (await cloud.prepare(ownerId))!;
    expect(next.id).not.toBe(first.id);
    expect(next.baseRevision).toBe(1);
    expect(next.snapshot!.project.name).toBe("Новый замер");
    await cloud.ack(next, 2);
    expect((await db.cloudStates.get(project.id))!.status).toBe("synced");
    expect(await db.outbox.count()).toBe(0);
    expect((await db.projects.get(project.id))!.name).toBe("Новый замер");
    await cloud.ack(first, 1);
    expect((await db.cloudStates.get(project.id))!.baseRevision).toBe(2);
  });
  it("retries the same command after a lost ACK with bounded backoff", async () => {
    const { db, cloud, project, ownerId } = await setup();
    await cloud.enroll(project.id, ownerId);
    const first = (await cloud.prepare(ownerId, 10))!;
    await cloud.failed(first, "offline", 10);
    expect(await cloud.prepare(ownerId, 11)).toBeUndefined();
    const retry = (await cloud.prepare(ownerId, 2011))!;
    expect(retry.id).toBe(first.id);
    expect(retry.snapshot).toEqual(first.snapshot);
    expect(retry.attempts).toBe(1);
    expect(await db.outbox.count()).toBe(1);
  });
  it("keeps both versions and blocks sending the conflicted project", async () => {
    const { db, cloud, project, ownerId, projects } = await setup();
    await cloud.enroll(project.id, ownerId);
    const entry = (await cloud.prepare(ownerId))!,
      remote = {
        ...entry.snapshot!,
        project: { ...entry.snapshot!.project, name: "Другой компьютер" },
      };
    await projects.rename(project.id, "Локальное изменение");
    await cloud.conflict(entry, remote, 3);
    expect((await db.projects.get(project.id))!.name).toBe(
      "Локальное изменение",
    );
    expect((await db.cloudConflicts.get(project.id))!.remote.project.name).toBe(
      "Другой компьютер",
    );
    expect(await cloud.prepare(ownerId)).toBeUndefined();
    const copyId = await cloud.resolve(project.id, ownerId, true);
    expect((await db.projects.get(copyId))!.name).toContain(
      "Локальное изменение",
    );
    expect((await db.projects.get(copyId))!.ownerId).toBeNull();
    expect((await db.projects.get(project.id))!.name).toBe("Другой компьютер");
    expect(await db.cloudConflicts.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });
  it("supports a new device download and never silently replaces an existing plan", async () => {
    const a = await setup();
    await a.cloud.enroll(a.project.id, a.ownerId);
    const remote = await snapshot(a.db, a.project.id),
      b = await setup();
    await b.cloud.download(remote, 1, b.ownerId);
    expect((await b.db.projects.get(a.project.id))!.name).toBe(
      remote.project.name,
    );
    await b.cloud.download(
      {
        ...remote,
        project: { ...remote.project, name: "Удалённое изменение" },
      },
      2,
      b.ownerId,
    );
    expect((await b.db.projects.get(a.project.id))!.name).toBe(
      remote.project.name,
    );
    expect((await b.db.cloudStates.get(a.project.id))!.status).toBe("conflict");
  });
  it("hides another account projects and prevents upload or edit under a new account", async () => {
    const { db, cloud, project, ownerId, projects, scenes, floor } =
      await setup();
    await cloud.enroll(project.id, ownerId);
    const entry = (await cloud.prepare(ownerId))!;
    db.currentOwnerId = uuid(901);
    expect(await projects.list()).toEqual([]);
    expect(await projects.get(project.id)).toBeUndefined();
    await expect(projects.rename(project.id, "Перезапись")).rejects.toThrow();
    await expect(scenes.load(floor.id)).rejects.toThrow("аккаунту");
    await expect(cloud.ack(entry, 1)).rejects.toThrow("Аккаунт изменился");
    expect(await db.outbox.count()).toBe(1);
  });
  it("stopping during upload leaves the immutable command available for the original account", async () => {
    const { db, cloud, project, ownerId } = await setup();
    await cloud.enroll(project.id, ownerId);
    let finish!: (r: { type: "ack"; revision: number }) => void;
    let started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    const transport: SyncTransport = {
        push: async () => {
          started();
          return new Promise((r) => {
            finish = r;
          });
        },
        list: async () => [],
      },
      worker = new SyncWorker(cloud, ownerId, transport),
      running = worker.run();
    await begun;
    worker.stop();
    finish({ type: "ack", revision: 1 });
    await running;
    expect(await db.outbox.count()).toBe(1);
    expect((await db.cloudStates.get(project.id))!.status).toBe("pending");
  });
  it("validates owner/identity of remote snapshots before persisting a conflict", async () => {
    const { db, cloud, project, ownerId } = await setup();
    await cloud.enroll(project.id, ownerId);
    const entry = (await cloud.prepare(ownerId))!;
    const remote = {
      ...entry.snapshot!,
      project: { ...entry.snapshot!.project, ownerId: uuid(901) },
    };
    await expect(cloud.conflict(entry, remote, 2)).rejects.toThrow("владельца");
    expect(await db.cloudConflicts.count()).toBe(0);
    expect(await db.outbox.count()).toBe(1);
  });
  it("clone remaps rooms, openings, dimensions and junction bindings", async () => {
    const { db, scenes, project, floor } = await setup(),
      w = wall(1, undefined, undefined, {
        floorId: floor.id,
        roomIds: [uuid(3)],
      }),
      w2 = wall(2, w.end, { x: 4.25, y: 3 }, { floorId: floor.id }),
      original = scene(
        [w, w2],
        [dimension(4, w, { roomIds: [uuid(3)] })],
        [junction(5, w, w2)],
      );
    original.elements = [
      {
        id: uuid(6),
        floorId: floor.id,
        roomIds: [uuid(3)],
        metadata: {},
        kind: "opening",
        wallId: w.id,
        type: "window",
        offset: 1,
        width: 1,
        height: 1.2,
        sill: 0.8,
        side: "left",
      },
    ];
    original.rooms = [
      {
        id: uuid(3),
        floorId: floor.id,
        name: "Комната",
        sourceKey: w.id + ":" + w2.id,
        wallIds: [w.id, w2.id],
        boundary: [],
        holes: [],
        edges: [[{ wallId: w.id, from: 0, to: 1 }]],
        height: null,
        geometricallyClosed: false,
        status: "inProgress",
      },
    ];
    await scenes.save(floor.id, original, 0);
    const s = await snapshot(db, project.id),
      copy = cloneSnapshot(s, "Копия"),
      cw = copy.walls.find((x) => x.start.x === 0)!,
      cr = copy.rooms[0];
    expect(copy.project.id).not.toBe(s.project.id);
    expect(copy.floors[0].projectId).toBe(copy.project.id);
    expect(cw.floorId).toBe(copy.floors[0].id);
    expect(cw.measuredLength).toBe(w.measuredLength);
    expect(cw.roomIds).toEqual([cr.id]);
    expect(copy.elements[0].roomIds).toEqual([cr.id]);
    expect(copy.elements[0]).toMatchObject({ kind: "opening", wallId: cw.id });
    expect(copy.dimensions[0].from.elementId).toBe(cw.id);
    expect(copy.junctions[0].endpoints[0].elementId).toBe(cw.id);
    expect(cr.edges[0][0].wallId).toBe(cw.id);
    expect(cr.wallIds).toContain(cw.id);
    expect(cr.sourceKey).not.toContain(w.id);
  });
  it("migrates an actual v4 database without claiming guest objects", async () => {
    const name = `v4-${crypto.randomUUID()}`,
      old = new Dexie(name);
    old.version(4).stores({
      projects: "id,status,updatedAt",
      floors: "id,projectId,[projectId+order]",
      walls: "id,floorId",
      elements: "id,floorId,kind,wallId",
      rooms: "id,floorId,status",
      junctions: "id,floorId",
      dimensions: "id,floorId",
      sceneRevisions: "floorId",
      recoveryDrafts: "id,floorId,updatedAt",
    });
    const { createProject } = await import("../../src/domain/projects"),
      data = createProject("Старый", "Первый");
    await old.table("projects").add(data.project);
    await old.table("floors").add(data.floor);
    old.close();
    const db = new ZamerDatabase(name);
    databases.push(db);
    expect(await db.projects.get(data.project.id)).toEqual(data.project);
    expect(await db.cloudStates.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });
});

it("preserves pending local recovery drafts when an explicit remote acceptance is attempted", async () => {
  const { db, cloud, project, ownerId, scenes, floor } = await setup();
  await cloud.enroll(project.id, ownerId);
  const entry = (await cloud.prepare(ownerId))!;
  await cloud.conflict(entry, entry.snapshot!, 2);
  await scenes.backup(uuid(77), floor.id, scene([]));
  await expect(cloud.resolve(project.id, ownerId, true)).rejects.toThrow(
    "восстановите",
  );
  expect(await db.cloudConflicts.count()).toBe(1);
  expect(await db.recoveryDrafts.count()).toBe(1);
});
