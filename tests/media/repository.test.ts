import { readFileSync } from "node:fs";
import { it, expect, afterEach } from "vitest";
import Dexie from "dexie";
import {
  ZamerDatabase,
  ProjectRepository,
} from "../../src/infrastructure/database";
import {
  MediaRepository,
  checksum,
  defectQuantities,
} from "../../src/infrastructure/media-repository";
import {
  CloudRepository,
  cloudTables,
  projectSnapshot,
  cloneSnapshot,
} from "../../src/infrastructure/cloud-repository";
import { parseSnapshot } from "../../src/domain/snapshot";
import type { Defect } from "../../src/domain/model";
const png = readFileSync(new URL("../fixtures/photo.png", import.meta.url));
const databases: ZamerDatabase[] = [];
afterEach(async () => {
  for (const d of databases.splice(0)) await d.delete();
});
async function setup() {
  const db = new ZamerDatabase(`media-${crypto.randomUUID()}`);
  databases.push(db);
  const projects = new ProjectRepository(db),
    { project, floor } = await projects.create("Замер", "Этаж"),
    media = new MediaRepository(db),
    now = new Date().toISOString();
  const defect: Defect = {
    id: crypto.randomUUID(),
    projectId: project.id,
    floorId: floor.id,
    roomId: null,
    elementId: null,
    type: "Трещина",
    description: "Стена повреждена",
    position: { x: 1, y: 2 },
    boundary: [],
    surface: "Стена",
    length: 2,
    width: 0.3,
    depth: 0.02,
    comment: "Проверить",
    recommendedWork: "Ремонт",
    status: "open",
    revision: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  return { db, projects, project, floor, media, defect };
}
const file = () =>
  new File([png], "original.png", { type: "image/png", lastModified: 123 });
it("keeps exact originals, deduplicates bytes and retains tombstones through trash/restore", async () => {
  const { db, media, defect, projects, project } = await setup();
  await media.saveDefect(defect, null);
  const a = await media.addPhoto(file(), { ...defect, defectId: defect.id }),
    b = await media.addPhoto(file(), { ...defect, defectId: defect.id });
  expect(await db.photoFiles.count()).toBe(1);
  expect(a.id).not.toBe(b.id);
  expect(a.checksum).toBe(await checksum(file()));
  expect(a.sourceModifiedAt).toBe(123);
  expect(
    Buffer.from(await (await media.file(a.id))!.original.arrayBuffer()),
  ).toEqual(png);
  await media.setPhotoDeleted(a.id, true);
  await projects.status(project.id, "trashed");
  await projects.status(project.id, "active");
  await media.setPhotoDeleted(a.id, false);
  expect((await db.photos.get(a.id))!.deletedAt).toBeNull();
  expect(await db.photoFiles.count()).toBe(1);
});
it("atomically rolls back binary, metadata and project revision on quota/outbox failure", async () => {
  const { db, media, project } = await setup();
  db.currentOwnerId = crypto.randomUUID();
  await new CloudRepository(db).enroll(project.id, db.currentOwnerId);
  const before = await db.projects.get(project.id);
  db.outbox.hook("creating", () => {
    throw new Error("quota");
  });
  await expect(
    media.addPhoto(file(), {
      projectId: project.id,
      floorId: null,
      roomId: null,
      elementId: null,
      defectId: null,
    }),
  ).rejects.toThrow("quota");
  expect(await db.photos.count()).toBe(0);
  expect(await db.photoFiles.count()).toBe(0);
  expect(await db.projects.get(project.id)).toEqual(before);
});
it("validates new bindings and blocks a different account reading original bytes", async () => {
  const { db, media, defect, project } = await setup();
  await expect(
    media.saveDefect({ ...defect, roomId: crypto.randomUUID() }, null),
  ).rejects.toThrow("Помещение");
  db.currentOwnerId = crypto.randomUUID();
  await new CloudRepository(db).enroll(project.id, db.currentOwnerId);
  const p = await media.addPhoto(file(), { ...defect, defectId: null });
  db.currentOwnerId = crypto.randomUUID();
  await expect(media.file(p.id)).rejects.toThrow("аккаунту");
  await expect(media.setPhotoDeleted(p.id, true)).rejects.toThrow("аккаунту");
});
it("rejects stale defect changes and rebinds attached photos in the same transaction", async () => {
  const { db, media, defect } = await setup();
  const saved = await media.saveDefect(defect, null),
    p = await media.addPhoto(file(), { ...defect, defectId: defect.id });
  await media.saveDefect({ ...saved, floorId: null }, saved.revision);
  expect((await db.photos.get(p.id))!.floorId).toBeNull();
  await expect(
    media.saveDefect({ ...saved, description: "stale" }, saved.revision),
  ).rejects.toThrow("другой вкладке");
});
it("rejects unsupported/empty/spoofed files without writing metadata", async () => {
  const { db, media, defect } = await setup();
  for (const f of [
    new File([], "empty.png", { type: "image/png" }),
    new File(["no"], "x.svg", { type: "image/svg+xml" }),
    new File(["no"], "x.png", { type: "image/png" }),
  ])
    await expect(
      media.addPhoto(f, { ...defect, defectId: null }),
    ).rejects.toThrow();
  expect(await db.photos.count()).toBe(0);
});
it("verifies downloaded checksums before caching a remote original", async () => {
  const { db, media, defect } = await setup();
  const p = await media.addPhoto(file(), { ...defect, defectId: null });
  await db.photoFiles.clear();
  await expect(media.cacheOriginal(p.id, new Blob(["bad"]))).rejects.toThrow(
    "целостности",
  );
  expect(await db.photoFiles.count()).toBe(0);
  await media.cacheOriginal(p.id, file());
  expect(await db.photoFiles.count()).toBe(1);
});
it("roundtrips report fields and remaps defect/photo bindings in cloud conflict copies", async () => {
  const { db, media, defect, project } = await setup();
  await media.saveDefect(defect, null);
  await media.addPhoto(file(), { ...defect, defectId: defect.id }, "Стена");
  const s = await db.transaction("r", cloudTables(db), () =>
      projectSnapshot(db, project.id),
    ),
    copy = cloneSnapshot(s, "Копия");
  expect(copy.defects[0].projectId).toBe(copy.project.id);
  expect(copy.photos[0].defectId).toBe(copy.defects[0].id);
  expect(copy.photos[0].checksum).toBe(s.photos[0].checksum);
  expect(copy.photos[0].storageKey).toContain(copy.project.id);
  expect(parseSnapshot(JSON.parse(JSON.stringify(s)))).toEqual(s);
  expect((await media.report(project.id))[0]).toMatchObject({
    area: 0.6,
    volume: 0.012,
    recommendedWork: "Ремонт",
    photos: [{ caption: "Стена" }],
  });
});
it("migrates snapshots v4 with empty media without altering geometry", async () => {
  const { db, project } = await setup();
  const s = await db.transaction("r", cloudTables(db), () =>
    projectSnapshot(db, project.id),
  );
  const { defects, photos, ...old } = s;
  expect(defects).toEqual([]);
  expect(photos).toEqual([]);
  const migrated = parseSnapshot({
    ...old,
    schemaVersion: 4,
    exportSchemaVersion: 4,
  });
  expect(migrated).toEqual(s);
});
it("migrates an actual Dexie v5 database without claiming projects or changing frozen commands", async () => {
  const name = `old-${crypto.randomUUID()}`,
    old = new Dexie(name);
  old.version(5).stores({
    projects: "id,status,updatedAt",
    floors: "id,projectId,[projectId+order]",
    walls: "id,floorId",
    elements: "id,floorId,kind,wallId",
    rooms: "id,floorId,status",
    junctions: "id,floorId",
    dimensions: "id,floorId",
    sceneRevisions: "floorId",
    recoveryDrafts: "id,floorId,updatedAt",
    cloudStates: "projectId,ownerId,status",
    outbox: "id,projectId,ownerId,nextAttemptAt",
    cloudConflicts: "projectId,ownerId",
  });
  const frozen = {
    id: crypto.randomUUID(),
    snapshot: { schemaVersion: 4 },
    nextAttemptAt: 0,
  };
  await old.table("outbox").add(frozen);
  old.close();
  const db = new ZamerDatabase(name);
  databases.push(db);
  expect(await db.outbox.get(frozen.id)).toEqual(frozen);
  expect(await db.photos.count()).toBe(0);
});
it("calculates only quantities whose dimensions are present", () => {
  expect(defectQuantities({ length: 2, width: null, depth: 0.3 })).toEqual({
    area: null,
    volume: null,
  });
});

it("enforces the 50 MB bound before reading oversized input", async () => {
  const { db, media, defect } = await setup();
  const oversized = file();
  Object.defineProperty(oversized, "size", { value: 52428801 });
  await expect(
    media.addPhoto(oversized, { ...defect, defectId: null }),
  ).rejects.toThrow("50 МБ");
  expect(await db.photoFiles.count()).toBe(0);
});
it("conflict acceptance preserves a locally usable photo copy with remapped metadata", async () => {
  const { db, media, defect, project } = await setup();
  await media.saveDefect(defect, null);
  const p = await media.addPhoto(file(), { ...defect, defectId: defect.id });
  db.currentOwnerId = crypto.randomUUID();
  const cloud = new CloudRepository(db);
  await cloud.enroll(project.id, db.currentOwnerId);
  const entry = (await cloud.prepare(db.currentOwnerId))!;
  await cloud.conflict(entry, entry.snapshot!, 2);
  const copyId = await cloud.resolve(project.id, db.currentOwnerId, true),
    copy = await media.list(copyId);
  expect(copy.photos).toHaveLength(1);
  expect(copy.photos[0].id).not.toBe(p.id);
  expect(await checksum((await media.file(copy.photos[0].id))!.original)).toBe(
    p.checksum,
  );
  expect(copy.photos[0].defectId).toBe(copy.defects[0].id);
  expect(await db.photoFiles.count()).toBe(1);
});
it("missing originals block a conflict copy instead of producing an unrecoverable guest backup", async () => {
  const { db, media, defect, project } = await setup();
  await media.addPhoto(file(), { ...defect, defectId: null });
  db.currentOwnerId = crypto.randomUUID();
  const cloud = new CloudRepository(db);
  await cloud.enroll(project.id, db.currentOwnerId);
  const entry = (await cloud.prepare(db.currentOwnerId))!;
  await cloud.conflict(entry, entry.snapshot!, 2);
  await db.photoFiles.clear();
  await expect(
    cloud.resolve(project.id, db.currentOwnerId, true),
  ).rejects.toThrow("оригиналы");
  expect(await db.cloudConflicts.count()).toBe(1);
  expect(await db.projects.count()).toBe(1);
});
