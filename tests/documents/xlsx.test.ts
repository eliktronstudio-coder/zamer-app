import { it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  createWorkbook,
  renderXlsx,
  XLSX_MIME,
} from "../../src/features/documents/xlsx";
import { readZip, createZip } from "../../src/features/export/zip";
import { betaSnapshot } from "../beta/fixture";
import { priceKey, type SavedReport } from "../../src/features/documents/model";
import {
  decodeProject,
  parsePackage,
  PROJECT_JSON,
  type PortableProject,
} from "../../src/features/export/package";
import { ZamerDatabase } from "../../src/infrastructure/database";
import { importProject } from "../../src/infrastructure/import-repository";
import {
  DocumentRepository,
  documentFingerprint,
} from "../../src/infrastructure/document-repository";
import { checksum } from "../../src/infrastructure/media-repository";
const dbs: ZamerDatabase[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.delete();
});
const xml = (files: Map<string, Uint8Array>, name: string) =>
  new TextDecoder().decode(files.get(name)!);
const fixture = () => {
  const source = betaSnapshot();
  source.floors = source.floors.slice(0, 1);
  source.walls = source.walls.filter((w) => w.floorId === source.floors[0].id);
  source.rooms = source.rooms.filter((r) => r.floorId === source.floors[0].id);
  source.defects = source.defects.filter(
    (d) => d.floorId === source.floors[0].id,
  );
  return source;
};
it("writes real OPC relationships, numeric values and literal strings without formulas or external links", () => {
  const literal =
    '=HYPERLINK("https://invalid.example", "x") & <tag>\r\n😀\u0000';
  const files = readZip(
    createWorkbook([
      {
        name: "Смета",
        rows: [
          ["Текст", "Число", "Неизвестно"],
          [literal, 4.257, null],
        ],
        moneyColumns: [1],
      },
    ]),
  );
  const sheet = xml(files, "xl/worksheets/sheet1.xml");
  expect(sheet).toContain('t="inlineStr"');
  expect(sheet).toContain("&amp; &lt;tag&gt;&#13;\n😀�");
  expect(sheet).toContain('<c r="B2" s="3"><v>4.257</v></c>');
  expect(sheet).not.toContain('r="C2"');
  expect(sheet).not.toContain("<f");
  expect(xml(files, "xl/workbook.xml")).toContain('name="Смета"');
  expect(xml(files, "xl/_rels/workbook.xml.rels")).toContain(
    'Target="worksheets/sheet1.xml"',
  );
  expect([...files.keys()]).not.toContain("xl/vbaProject.bin");
  expect(
    [...files.values()].map((b) => new TextDecoder().decode(b)).join(""),
  ).not.toContain('TargetMode="External"');
  expect(sheet).toContain('state="frozen"');
  expect(sheet).toContain('<autoFilter ref="A1:C2"');
});
it("preserves the application's decimal estimate, exclusion, blanks, provenance and source without mutation", async () => {
  const source = fixture(),
    room = source.rooms[0],
    before = JSON.stringify(source),
    ownerId = null;
  const prices = [
    {
      id: priceKey(ownerId, "Отделка пола", "m2"),
      ownerId,
      name: "Отделка пола",
      unit: "m2" as const,
      kopecks: 12345,
      updatedAt: source.project.updatedAt,
    },
  ];
  const output = renderXlsx(
    source,
    prices,
    ownerId,
    { floorId: room.floorId, roomId: room.id },
    ["quantities", "estimate"],
    [room.id + ":walls"],
  );
  const bytes = new Uint8Array(await output.files[0].blob.arrayBuffer());
  const files = readZip(bytes),
    sheet = xml(files, "xl/worksheets/sheet3.xml");
  expect(output.files[0].blob.type).toBe(XLSX_MIME);
  expect(output.pageCount).toBe(3);
  const quantity = Number(sheet.match(/<c r="D2"[^>]*><v>([^<]+)<\/v>/)?.[1]);
  expect(quantity).toBeCloseTo(12.771, 12);
  expect(sheet).toContain(String(quantity));
  expect(sheet).toContain("<v>123.45</v>");
  expect(sheet).toContain("<v>1576.58</v>");
  expect(sheet).toContain("157658");
  expect(sheet).toContain("Исключена");
  expect(sheet).toContain("Цена не задана");
  expect(sheet).toContain("смета неполная");
  expect(sheet).toContain(room.id);
  expect(JSON.stringify(source)).toBe(before);
  mkdirSync("artifacts", { recursive: true });
  writeFileSync("artifacts/xlsx-estimate.xlsx", bytes);
});
it("unknown quantities are blank rather than zero and selected room cannot include other room data", async () => {
  const source = fixture(),
    room = source.rooms[0];
  room.geometricallyClosed = false;
  const output = renderXlsx(
    source,
    [],
    null,
    { floorId: room.floorId, roomId: room.id },
    ["quantities", "estimate"],
  );
  const files = readZip(
      new Uint8Array(await output.files[0].blob.arrayBuffer()),
    ),
    sheet = xml(files, "xl/worksheets/sheet2.xml");
  expect(sheet).not.toContain('r="D2"');
  expect(sheet).toContain(room.id);
  expect(sheet).not.toContain(source.rooms[1].id);
  expect(xml(files, "xl/worksheets/sheet3.xml")).toContain("Объём неизвестен");
});
it("rejects invalid sheets, excessive cells and invalid numbers before returning a workbook", () => {
  expect(() => createWorkbook([])).toThrow();
  expect(() => createWorkbook([{ name: "bad/name", rows: [] }])).toThrow();
  expect(() => createWorkbook([{ name: "'bad", rows: [] }])).toThrow();
  expect(() =>
    createWorkbook([
      { name: "A", rows: [] },
      { name: "a", rows: [] },
    ]),
  ).toThrow();
  expect(() => createWorkbook([{ name: "A", rows: [[Infinity]] }])).toThrow(
    "число",
  );
  expect(() =>
    createWorkbook([{ name: "A", rows: [["x".repeat(32768)]] }]),
  ).toThrow("32767");
  expect(() =>
    createWorkbook([{ name: "A", rows: [Array(101).fill(0)] }]),
  ).toThrow("большая таблица");
  const source = fixture();
  expect(() =>
    renderXlsx(source, [], null, { floorId: null, roomId: null }, [
      "plans",
      "views",
    ]),
  ).toThrow("табличный");
  expect(() =>
    renderXlsx(
      source,
      [],
      null,
      { floorId: crypto.randomUUID(), roomId: null },
      ["estimate"],
    ),
  ).toThrow("недоступна");
});
it("package v2 restores immutable XLSX history and v1 rejects the new format while old v1 still loads", async () => {
  const source = fixture(),
    room = source.rooms[0],
    output = renderXlsx(
      source,
      [],
      null,
      { floorId: room.floorId, roomId: room.id },
      ["estimate"],
    ),
    blob = output.files[0].blob;
  const report: SavedReport = {
    ...output,
    id: crypto.randomUUID(),
    projectId: source.project.id,
    ownerId: null,
    sourceRevision: 0,
    sourceFingerprint: await documentFingerprint(source, []),
    sections: ["estimate"],
    scope: { floorId: room.floorId, roomId: room.id },
    excludedIds: [],
    format: "xlsx",
    source,
    prices: [],
  };
  const path = "00_Общий_отчет/История/estimate.xlsx",
    file = {
      path,
      checksum: await checksum(blob),
      size: blob.size,
      mimeType: XLSX_MIME as typeof XLSX_MIME,
    };
  const manifest: PortableProject = {
    format: "zamer-project",
    packageVersion: 2,
    createdAt: output.createdAt,
    source,
    prices: [],
    excludedIds: [],
    originals: [],
    documents: [],
    artifacts: [],
    warnings: [],
  };
  // Owner/projectId are local fields, not part of the portable document metadata.
  const { ownerId, projectId, ...portableReport } = report;
  void ownerId;
  void projectId;
  manifest.documents = [
    { ...portableReport, excludedIds: report.excludedIds ?? [], files: [file] },
  ];
  const files = new Map([
    [path, new Uint8Array(await blob.arrayBuffer())],
    [PROJECT_JSON, new TextEncoder().encode(JSON.stringify(manifest))],
  ]);
  await expect(
    parsePackage({ ...manifest, packageVersion: 1 }, files),
  ).rejects.toThrow("версию пакета 2");
  const decoded = await decodeProject(createZip(files)),
    db = new ZamerDatabase(`xlsx-${crypto.randomUUID()}`);
  dbs.push(db);
  const copy = await importProject(db, decoded, "Копия XLSX"),
    docs = (await new DocumentRepository(db).load(copy.project.id)).documents;
  expect(docs).toHaveLength(1);
  expect(docs[0].format).toBe("xlsx");
  expect(docs[0].source.project.id).toBe(source.project.id);
  expect(
    Buffer.compare(
      Buffer.from(await docs[0].files[0].blob.arrayBuffer()),
      Buffer.from(await blob.arrayBuffer()),
    ),
  ).toBe(0);
  await expect(
    parsePackage(
      { ...manifest, packageVersion: 1, documents: [] },
      new Map(),
      true,
    ),
  ).resolves.toMatchObject({ manifest: { packageVersion: 1 } });
  const invalid = {
    ...manifest,
    documents: [
      {
        ...manifest.documents[0],
        files: [{ ...file, mimeType: "application/pdf" as const }],
      },
    ],
  };
  await expect(parsePackage(invalid, files, true)).rejects.toThrow(
    "формат исторического",
  );
});
it("builds the full 20-floor analytical tables within the workbook budget", async () => {
  const source = betaSnapshot();
  const output = renderXlsx(source, [], null, { floorId: null, roomId: null }, [
    "rooms",
    "quantities",
    "defects",
    "estimate",
  ]);
  expect(output.pageCount).toBe(5);
  expect(output.files[0].blob.size).toBeLessThan(2 * 1024 * 1024);
});
