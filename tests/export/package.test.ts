import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import Dexie from "dexie";
import { zipSync } from "fflate";
import {
  ZamerDatabase,
  ProjectRepository,
} from "../../src/infrastructure/database";
import { projectSnapshot } from "../../src/infrastructure/cloud-repository";
import { DocumentRepository } from "../../src/infrastructure/document-repository";
import {
  MediaRepository,
  checksum,
} from "../../src/infrastructure/media-repository";
import { importProject } from "../../src/infrastructure/import-repository";
import {
  decodeProject,
  parsePackage,
  PROJECT_JSON,
  type PortableProject,
} from "../../src/features/export/package";
import { createZip, readZip, crc32 } from "../../src/features/export/zip";
import {
  segment,
  assertPath,
  MAX_ENTRY,
} from "../../src/features/export/paths";
import { createRoom } from "../../src/calculation/engine";
import { detectRooms } from "../../src/geometry/rooms";
import { buildStatement } from "../../src/features/documents/model";
import { wall, uuid } from "../geometry/fixtures";
const png = readFileSync(new URL("../fixtures/photo.png", import.meta.url)),
  dbs: ZamerDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) await db.delete();
});
async function setup() {
  const db = new ZamerDatabase(`export-${crypto.randomUUID()}`);
  dbs.push(db);
  const { project, floor } = await new ProjectRepository(db).create(
    "../Дом: 1",
    "Этаж / 1",
  );
  const walls = [
    wall(1, { x: 0, y: 0 }, { x: 4.257, y: 0 }),
    wall(2, { x: 4.257, y: 0 }, { x: 4.257, y: 3 }),
    wall(3, { x: 4.257, y: 3 }, { x: 0, y: 3 }),
    wall(4, { x: 0, y: 3 }, { x: 0, y: 0 }),
  ].map((w) => ({ ...w, floorId: floor.id }));
  await db.walls.bulkAdd(walls);
  const room = createRoom(
    detectRooms(walls).candidates[0],
    "../Кухня: 1",
    null,
  );
  await db.rooms.add(room);
  await db.dimensions.add({
    id: uuid(20),
    floorId: floor.id,
    roomIds: [room.id],
    metadata: {},
    kind: "dimension",
    mode: "reference",
    from: { elementId: walls[0].id, anchor: "start" },
    to: { elementId: walls[0].id, anchor: "end" },
    offset: 0.3,
    inputValue: null,
  });
  const media = new MediaRepository(db);
  const photo = await media.addPhoto(
    new File([png], "../Оригинал.png", {
      type: "image/png",
      lastModified: 321,
    }),
    {
      projectId: project.id,
      floorId: floor.id,
      roomId: room.id,
      elementId: null,
      defectId: null,
    },
    "У окна",
  );
  const source = await projectSnapshot(db, project.id),
    path = "05_Фотографии/Этаж/Кухня/Фото.png";
  const manifest: PortableProject = {
    format: "zamer-project",
    packageVersion: 1,
    createdAt: new Date().toISOString(),
    source,
    prices: [{ name: "Отделка пола", unit: "m2", kopecks: 12345 }],
    excludedIds: [room.id + ":walls"],
    originals: [
      {
        path,
        checksum: photo.checksum,
        size: png.length,
        mimeType: "image/png",
      },
    ],
    documents: [],
    artifacts: [],
    warnings: [],
  };
  const files = new Map([
    [path, new Uint8Array(png)],
    [PROJECT_JSON, new TextEncoder().encode(JSON.stringify(manifest))],
  ]);
  return { db, project, floor, room, photo, manifest, files, source };
}
it("roundtrips a complete ZIP and imports a new editable copy with original bytes, links, prices and exclusions", async () => {
  const { db, manifest, files, source, room } = await setup();
  const decoded = await decodeProject(createZip(files)),
    copy = await importProject(db, decoded, "Копия");
  expect(copy.project.id).not.toBe(source.project.id);
  expect(await projectSnapshot(db, source.project.id)).toEqual(source);
  expect(copy.walls[0].measuredLength).toBe(4.257);
  expect(copy.rooms[0].sourceKey).toBe(
    copy.walls
      .map((w) => w.id)
      .sort()
      .join(":"),
  );
  expect(copy.dimensions[0].from.elementId).toBe(copy.walls[0].id);
  expect(copy.photos[0].roomId).toBe(copy.rooms[0].id);
  expect(copy.photos[0].sourceModifiedAt).toBe(321);
  expect(
    await (await db.photoFiles.get(
      copy.photos[0].checksum,
    ))!.original.arrayBuffer(),
  ).toEqual(new Uint8Array(png).buffer);
  const data = await new DocumentRepository(db).load(copy.project.id);
  expect(data.prices.find((p) => p.name === "Отделка пола")!.kopecks).toBe(
    12345,
  );
  expect(data.excludedIds).toEqual([copy.rooms[0].id + ":walls"]);
  expect(room.id).not.toBe(copy.rooms[0].id);
  expect(await db.outbox.where({ projectId: copy.project.id }).count()).toBe(0);
  expect(decoded.manifest).toEqual(manifest);
});
it("preserves an existing catalog price while keeping the imported price specific to the copy", async () => {
  const { db, files } = await setup(),
    repo = new DocumentRepository(db);
  await repo.setPrice("Отделка пола", "m2", 999);
  const copy = await importProject(
    db,
    await decodeProject(createZip(files)),
    "Копия",
  );
  expect((await db.workPrices.toArray())[0].kopecks).toBe(999);
  expect(
    (await repo.load(copy.project.id)).prices.find(
      (p) => p.name === "Отделка пола",
    )!.kopecks,
  ).toBe(12345);
  await repo.setPrice("Отделка пола", "m2", 777, copy.project.id);
  expect(
    (await repo.load(copy.project.id)).prices.find(
      (p) => p.name === "Отделка пола",
    )!.kopecks,
  ).toBe(777);
  expect(await db.projectWorkPrices.count()).toBe(0);
});
it("JSON-only import makes missing originals explicit and accepts legacy snapshots", async () => {
  const { db, source } = await setup();
  const legacy = await decodeProject(
    new TextEncoder().encode(JSON.stringify(source)),
    true,
  );
  expect(legacy.jsonOnly).toBe(true);
  const target = new ZamerDatabase(`json-${crypto.randomUUID()}`);
  dbs.push(target);
  const copy = await importProject(target, legacy, "Без фото");
  expect(copy.photos).toHaveLength(1);
  expect(await target.photoFiles.count()).toBe(0);
  expect(await db.projects.count()).toBe(1);
});
it("rolls back the entire import when saving a late price record fails", async () => {
  const { db, files, source } = await setup();
  vi.spyOn(db.projectWorkPrices, "bulkAdd").mockImplementation(() =>
    Dexie.Promise.reject(new DOMException("quota", "QuotaExceededError")),
  );
  await expect(
    importProject(db, await decodeProject(createZip(files)), "Копия"),
  ).rejects.toThrow("quota");
  expect(await db.projects.count()).toBe(1);
  expect(await db.documents.count()).toBe(0);
  expect(await projectSnapshot(db, source.project.id)).toEqual(source);
});
it("preserves immutable historical reports rather than rewriting their rendered source IDs", async () => {
  const { db, manifest, files, source } = await setup(),
    blob = new Blob(["%PDF-1.7 historic"], { type: "application/pdf" }),
    path = "00_Общий_отчет/История/report.pdf";
  files.set(path, new Uint8Array(await blob.arrayBuffer()));
  manifest.documents.push({
    id: uuid(60),
    createdAt: new Date().toISOString(),
    title: "История",
    sourceRevision: source.project.revision,
    sourceFingerprint: "a".repeat(64),
    sections: ["summary"],
    scope: { floorId: null, roomId: null },
    format: "pdf",
    pageCount: 1,
    source,
    prices: manifest.prices,
    excludedIds: [],
    rows: buildStatement(source).rows,
    files: [
      {
        path,
        size: blob.size,
        mimeType: "application/pdf",
        checksum: await checksum(blob),
      },
    ],
  });
  files.set(PROJECT_JSON, new TextEncoder().encode(JSON.stringify(manifest)));
  const copy = await importProject(
      db,
      await decodeProject(createZip(files)),
      "Копия",
    ),
    reports = await db.documents
      .where({ projectId: copy.project.id })
      .toArray();
  expect(reports[0].source.project.id).toBe(source.project.id);
  expect(reports[0].id).not.toBe(uuid(60));
  expect(await reports[0].files[0].blob.text()).toBe(await blob.text());
});
it.each([
  "../x",
  "/x",
  "C:/x",
  "a\\b",
  "a/../b",
  "a//b",
  "a/CON.txt",
  "a/name.",
  "a/имя ",
  "a/e\u0301",
])("rejects unsafe archive path %s", (path) => {
  expect(() => assertPath(path)).toThrow();
  expect(() => readZip(zipSync({ [path]: new Uint8Array([1]) }))).toThrow();
});
it("normalizes user filenames without allowing path traversal or reserved Windows names", () => {
  expect(segment("../Кухня: 1/")).toBe("_Кухня_ 1_");
  expect(segment("CON")).toBe("_CON");
  expect(segment("... ")).toBe("Без_названия");
  expect(segment("e\u0301")).toBe("é");
});
it("rejects case-colliding paths, corrupted CRC, symlinks and oversized declared output before extraction", () => {
  expect(() =>
    readZip(
      zipSync({ "A.txt": new Uint8Array([1]), "a.txt": new Uint8Array([2]) }),
    ),
  ).toThrow();
  const zip = zipSync({ x: new Uint8Array([1, 2, 3]) }, { level: 0 }),
    crcBad = zip.slice();
  crcBad[31] ^= 1;
  expect(() => readZip(crcBad)).toThrow(/CRC/);
  const view = new DataView(zip.buffer);
  let c = 0;
  while (view.getUint32(c, true) !== 0x02014b50) c++;
  const large = zip.slice();
  new DataView(large.buffer).setUint32(c + 24, MAX_ENTRY + 1, true);
  expect(() => readZip(large)).toThrow();
  const link = zip.slice();
  new DataView(link.buffer).setUint32(c + 38, 0xa1ff0000, true);
  expect(() => readZip(link)).toThrow();
});
it("checks actual DEFLATE size independently of forged central directory headers", () => {
  const zipped = zipSync({ bomb: new Uint8Array(1024 * 1024) }, { level: 6 }),
    view = new DataView(zipped.buffer);
  let c = 0;
  while (view.getUint32(c, true) !== 0x02014b50) c++;
  view.setUint32(c + 24, 10, true);
  expect(() => readZip(zipped)).toThrow(/Фактический размер/);
});
it("rejects missing files, altered SHA, unknown versions, bad references and unexpected files", async () => {
  const { manifest, files } = await setup();
  const missing = new Map(files);
  missing.delete(manifest.originals[0].path);
  await expect(parsePackage(manifest, missing)).rejects.toThrow(/повреждён/);
  await expect(
    parsePackage({ ...manifest, packageVersion: 99 }, files),
  ).rejects.toThrow();
  const bad = structuredClone(manifest);
  bad.originals[0].checksum = "b".repeat(64);
  await expect(parsePackage(bad, files)).rejects.toThrow();
  const extra = new Map(files);
  extra.set("unlisted.txt", new Uint8Array([1]));
  await expect(parsePackage(manifest, extra)).rejects.toThrow(/манифесте/);
  expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
});
it("upgrades v7 with existing documents and prices without changing their contents", async () => {
  const name = `migration-export-${crypto.randomUUID()}`,
    old = new Dexie(name);
  old.version(7).stores({
    workPrices: "id,ownerId",
    estimateSettings: "id,projectId,ownerId",
    documents: "id,projectId,ownerId,createdAt",
  });
  await old
    .table("workPrices")
    .add({ id: "old", name: "Работа", kopecks: 100 });
  await old.table("documents").add({
    id: uuid(100),
    files: [{ name: "report.pdf", blob: new Blob(["pdf"]) }],
  });
  old.close();
  const db = new ZamerDatabase(name);
  dbs.push(db);
  await db.open();
  expect((await db.workPrices.get("old"))!.kopecks).toBe(100);
  expect(await (await db.documents.get(uuid(100)))!.files[0].blob.text()).toBe(
    "pdf",
  );
  expect(await db.projectWorkPrices.count()).toBe(0);
});
