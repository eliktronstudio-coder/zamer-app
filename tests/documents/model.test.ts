import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import Dexie from "dexie";
import {
  ZamerDatabase,
  ProjectRepository,
} from "../../src/infrastructure/database";
import {
  DocumentRepository,
  documentFingerprint,
} from "../../src/infrastructure/document-repository";
import { projectSnapshot } from "../../src/infrastructure/cloud-repository";
import {
  buildStatement,
  estimate,
  lineCost,
  parsePrice,
  priceKey,
  type SavedReport,
} from "../../src/features/documents/model";
import {
  ReportLayout,
  safeFileName,
} from "../../src/features/documents/render";
import { detectRooms } from "../../src/geometry/rooms";
import { createRoom } from "../../src/calculation/engine";
import { wall, uuid, deepFreeze } from "../geometry/fixtures";
const databases: ZamerDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete();
});
async function setup() {
  const db = new ZamerDatabase(`documents-${crypto.randomUUID()}`);
  databases.push(db);
  const { project, floor } = await new ProjectRepository(db).create(
    "Дом",
    "Этаж 1",
  );
  const walls = [
    wall(1, { x: 0, y: 0 }, { x: 4.257, y: 0 }),
    wall(2, { x: 4.257, y: 0 }, { x: 4.257, y: 3 }),
    wall(3, { x: 4.257, y: 3 }, { x: 0, y: 3 }),
    wall(4, { x: 0, y: 3 }, { x: 0, y: 0 }),
  ].map((w) => ({ ...w, floorId: floor.id }));
  const room = createRoom(detectRooms(walls).candidates[0], "Кухня", null);
  await db.walls.bulkPut(walls);
  await db.rooms.add(room);
  return {
    db,
    project,
    floor,
    room,
    repository: new DocumentRepository(db),
    source: await projectSnapshot(db, project.id),
  };
}
it.each([
  ["125 000,01", 12500001],
  ["0", 0],
  ["0,01", 1],
  ["1.5", 150],
  ["-1", null],
  ["1.001", null],
  ["1e3", null],
  ["Infinity", null],
  ["10000000001", null],
  ["", null],
])("parses exact currency %s", (s, n) =>
  expect(parsePrice(s as string)).toBe(n),
);
it("rounds from unrounded geometric quantities once and marks missing and overflowing costs", () => {
  expect(lineCost(4.257 * 3, 12345)).toBe(157658);
  expect(lineCost(1.005, 100)).toBe(101);
  expect(lineCost(null, 100)).toBeNull();
  expect(lineCost(3, null)).toBeNull();
  expect(lineCost(1, 0)).toBe(0);
  expect(lineCost(1e20, 1000)).toBeNull();
});
it("derives quantities without mutating the snapshot and traces window subtraction", async () => {
  const { source, floor, room } = await setup();
  source.elements.push({
    id: uuid(10),
    floorId: floor.id,
    roomIds: [room.id],
    metadata: {},
    kind: "opening",
    type: "window",
    wallId: source.walls[0].id,
    offset: 1,
    width: 1.2,
    height: 1,
    sill: 1,
    side: "left",
  });
  const before = JSON.stringify(source);
  const result = buildStatement(deepFreeze(source));
  const floorRow = result.rows.find((r) => r.id.endsWith(":floor"))!,
    wallRow = result.rows.find((r) => r.id.endsWith(":walls"))!;
  expect(floorRow.quantity).toBeCloseTo(12.771, 8);
  expect(wallRow.quantity).toBeCloseTo(2 * (4.257 + 3) * 2.7 - 1.2, 8);
  expect(wallRow.explanation).toContain("окна 1,2");
  expect(wallRow.sourceId).toBe(room.id);
  expect(JSON.stringify(source)).toBe(before);
});
it("broken room stays unknown instead of zero and estimates remain partial", async () => {
  const { source } = await setup();
  source.walls.pop();
  const result = buildStatement(source);
  expect(result.rows.find((r) => r.id.endsWith(":floor"))!.quantity).toBeNull();
  expect(estimate(result.rows, [], null).complete).toBe(false);
});
it("floor and room scopes exclude other floors, defects and photos", async () => {
  const { source, floor, room } = await setup();
  const other = { ...floor, id: uuid(90), name: "Другой" };
  source.floors.push(other);
  source.rooms.push({ ...room, id: uuid(91), floorId: other.id });
  const result = buildStatement(source, { floorId: floor.id, roomId: room.id });
  expect(result.analyses).toHaveLength(1);
  expect(result.rows.every((r) => r.sourceId === room.id)).toBe(true);
});
it("defect work preserves comments and photo references; tombstones and unknown dimensions are explicit", async () => {
  const { source, floor, room } = await setup(),
    now = new Date().toISOString();
  const defect = {
    id: uuid(300),
    projectId: source.project.id,
    floorId: floor.id,
    roomId: room.id,
    elementId: null,
    type: "Трещина",
    description: "Под окном",
    position: null,
    boundary: [],
    surface: "Стена",
    length: 2,
    width: 0.3,
    depth: 0.02,
    comment: "Проверить основание",
    recommendedWork: "Заделка",
    status: "open" as const,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  source.defects.push(
    defect,
    { ...defect, id: uuid(301), length: null },
    { ...defect, id: uuid(302), deletedAt: now },
  );
  source.photos.push({
    id: uuid(400),
    projectId: source.project.id,
    floorId: floor.id,
    roomId: room.id,
    elementId: null,
    defectId: defect.id,
    storageKey: "original",
    checksum: "a".repeat(64),
    originalName: "Фото.png",
    mimeType: "image/png",
    size: 100,
    caption: "Под окном",
    createdAt: now,
    sourceModifiedAt: 0,
    deletedAt: null,
  });
  const result = buildStatement(source),
    rows = result.rows.filter((r) => r.id.endsWith(":defect"));
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    name: "Заделка",
    unit: "m3",
    quantity: 0.012,
    photoIds: [uuid(400)],
  });
  expect(rows[0].comment).toContain("Проверить основание");
  expect(rows[1].quantity).toBeNull();
});
it("prices are reusable by work and unit, zero is valid, missing is separate", async () => {
  const { db, source, repository } = await setup();
  await repository.setPrice("Отделка пола", "m2", 0);
  const a = await repository.load(source.project.id);
  const result = estimate(buildStatement(source).rows, a.prices, null);
  expect(result.lines.find((r) => r.name === "Отделка пола")!.cost).toBe(0);
  expect(result.missing).toBe(3);
  await repository.setPrice("Отделка пола", "m2", null);
  expect(await db.workPrices.count()).toBe(0);
  expect(priceKey(null, " РЕМОНТ ", "m2")).toBe(priceKey(null, "ремонт", "m2"));
});
it("excluded work stays in quantities but cannot inflate the estimate; composition survives reopening", async () => {
  const { db, repository, source } = await setup();
  const rows = buildStatement(source).rows,
    excluded = rows.slice(1).map((r) => r.id);
  await repository.setPrice("Отделка пола", "m2", 12345);
  await repository.setExcluded(source.project.id, excluded);
  db.close();
  await db.open();
  const data = await repository.load(source.project.id),
    result = estimate(rows, data.prices, null, data.excludedIds);
  expect(result.complete).toBe(true);
  expect(result.subtotal).toBe(157658);
  expect(result.missing).toBe(0);
  expect(result.lines).toHaveLength(4);
  expect(result.lines.filter((r) => r.included)).toHaveLength(1);
  expect(await documentFingerprint(source, data.prices, excluded)).not.toBe(
    await documentFingerprint(source, data.prices),
  );
});
it("isolates owner price catalog and blocks access to another owner's project", async () => {
  const { db, project, repository } = await setup();
  db.currentOwnerId = uuid(70);
  await repository.setPrice("Ремонт", "m2", 100);
  await db.projects.update(project.id, { ownerId: uuid(70) });
  db.currentOwnerId = uuid(71);
  await expect(repository.load(project.id)).rejects.toThrow();
  await db.projects.update(project.id, { ownerId: null });
  expect((await repository.load(project.id)).prices).toHaveLength(0);
});
it("persists immutable reports and source provenance, detects changed prices and preserves originals", async () => {
  const { db, repository, source } = await setup();
  const hash = await documentFingerprint(source, []);
  const blob = new Blob(["%PDF-1.7 report"], { type: "application/pdf" });
  const report: SavedReport = {
    id: crypto.randomUUID(),
    projectId: source.project.id,
    ownerId: null,
    sourceRevision: source.project.revision,
    sourceFingerprint: hash,
    title: "Отчёт",
    sections: ["summary"],
    scope: { floorId: null, roomId: null },
    format: "pdf",
    files: [{ name: "Отчёт.pdf", blob }],
    pageCount: 1,
    source,
    prices: [],
    rows: buildStatement(source).rows,
    createdAt: new Date().toISOString(),
  };
  await repository.save(report);
  db.close();
  await db.open();
  const loaded = await repository.load(source.project.id);
  expect(loaded.documents).toHaveLength(1);
  expect(await loaded.documents[0].files[0].blob.text()).toBe(
    await blob.text(),
  );
  await repository.setPrice("Отделка пола", "m2", 1);
  expect(
    await documentFingerprint(
      source,
      (await repository.load(source.project.id)).prices,
    ),
  ).not.toBe(hash);
  expect(loaded.documents[0].prices).toEqual([]);
  await expect(
    repository.save({ ...report, id: crypto.randomUUID(), files: [] }),
  ).rejects.toThrow();
  expect(await db.documents.count()).toBe(1);
});
it("quota failure rolls back document history without touching source data", async () => {
  const { db, repository, source } = await setup();
  const add = vi
    .spyOn(db.documents, "add")
    .mockImplementation(() =>
      Dexie.Promise.reject(new DOMException("quota", "QuotaExceededError")),
    );
  const report = {
    id: uuid(80),
    projectId: source.project.id,
    ownerId: null,
    files: [{ name: "a.pdf", blob: new Blob(["pdf"]) }],
  } as SavedReport;
  await expect(repository.save(report)).rejects.toThrow();
  add.mockRestore();
  expect(await db.documents.count()).toBe(0);
  expect(await projectSnapshot(db, source.project.id)).toEqual(source);
});
it("upgrades a real v6 database preserving project and media while adding empty report tables", async () => {
  const name = `migration-documents-${crypto.randomUUID()}`;
  const old = new Dexie(name);
  old.version(6).stores({
    projects: "id,status,updatedAt",
    floors: "id,projectId,[projectId+order]",
    walls: "id,floorId",
    junctions: "id,floorId",
    dimensions: "id,floorId",
    sceneRevisions: "floorId",
    recoveryDrafts: "id,floorId,updatedAt",
    elements: "id,floorId,kind,wallId",
    rooms: "id,floorId,status",
    cloudStates: "projectId,ownerId,status",
    outbox: "id,projectId,ownerId,nextAttemptAt",
    cloudConflicts: "projectId,ownerId",
    defects: "id,projectId,floorId,roomId,elementId",
    photos: "id,projectId,floorId,defectId,checksum",
    photoFiles: "checksum",
    photoTransfers: "photoId,projectId,uploaded",
  });
  await old.table("projects").add({ id: uuid(1), name: "Существующий" });
  await old
    .table("photoFiles")
    .add({ checksum: "abc", original: new Blob(["original"]), preview: null });
  old.close();
  const db = new ZamerDatabase(name);
  databases.push(db);
  await db.open();
  expect((await db.projects.get(uuid(1)))!.name).toBe("Существующий");
  expect(await (await db.photoFiles.get("abc"))!.original.text()).toBe(
    "original",
  );
  expect(await db.documents.count()).toBe(0);
  expect(await db.workPrices.count()).toBe(0);
});
it("paginates long Cyrillic text and unbroken words within printable bounds", async () => {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(
    readFileSync(new URL("../../public/fonts/DejaVuSans.ttf", import.meta.url)),
    { subset: true },
  );
  const layout = new ReportLayout(font);
  layout.text("Кириллица: штукатурка стен, 125 000,00 ₽");
  layout.text("Оченьдлинноеслово".repeat(100));
  for (let i = 0; i < 100; i++) layout.text("Помещение № " + i);
  expect(layout.pages.length).toBeGreaterThan(2);
  for (const page of layout.pages)
    for (const draw of page)
      if (draw.kind === "text") {
        expect(
          font.widthOfTextAtSize(draw.text, draw.size),
        ).toBeLessThanOrEqual(516);
        expect(draw.y + draw.size).toBeLessThan(802);
      }
  expect(layout.pages[0][0]).toMatchObject({
    text: "Кириллица: штукатурка стен, 125 000,00 ₽",
  });
  expect(safeFileName("../План: этаж/1\u0000.")).toBe(".._План_ этаж_1_");
});
