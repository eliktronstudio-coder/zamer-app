import { XLSX_MIME } from "../documents/xlsx";
import { z } from "zod";
import { parseSnapshot } from "../../domain/snapshot";
import { checksum } from "../../infrastructure/media-repository";
import { assertPath } from "./paths";
import { readZip } from "./zip";
const id = z.uuid(),
  sha = z.string().regex(/^[a-f0-9]{64}$/),
  unit = z.enum(["m", "m2", "m3", "pcs"]);
const price = z
  .object({
    name: z.string().trim().min(1).max(500),
    unit,
    kopecks: z.number().int().min(0).max(1e12),
  })
  .strict();
const file = z
  .object({
    path: z.string().max(512),
    checksum: sha,
    size: z
      .number()
      .int()
      .positive()
      .max(52 * 1024 * 1024),
    mimeType: z.enum([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
      "application/pdf",
      XLSX_MIME,
      "text/plain",
    ]),
  })
  .strict();
const snapshot = z.unknown().transform((v) => parseSnapshot(v));
const scope = z
  .object({ floorId: id.nullable(), roomId: id.nullable() })
  .strict();
const sections = z
  .array(
    z.enum([
      "summary",
      "rooms",
      "quantities",
      "defects",
      "estimate",
      "photos",
      "issues",
      "plans",
      "views",
    ]),
  )
  .min(1)
  .max(9);
const row = z
  .object({
    id: z.string().max(128),
    sourceId: id,
    floorId: z.union([id, z.literal("")]),
    roomId: id.nullable(),
    name: z.string().max(500),
    location: z.string().max(500),
    unit,
    quantity: z.number().finite().nonnegative().nullable(),
    explanation: z.string().max(8000),
    comment: z.string().max(10000),
    photoIds: z.array(id).max(20000),
  })
  .strict();
const report = z
  .object({
    id,
    createdAt: z.iso.datetime(),
    title: z.string().max(500),
    sourceRevision: z.number().int().nonnegative(),
    sourceFingerprint: sha,
    sections,
    scope,
    format: z.enum(["pdf", "jpeg", "xlsx"]),
    pageCount: z.number().int().min(1).max(10000),
    source: snapshot,
    prices: z.array(price).max(10000),
    excludedIds: z.array(z.string().max(128)).max(50000),
    rows: z.array(row).max(50000),
    files: z.array(file).min(1).max(10000),
  })
  .strict();
export const packageSchema = z
  .object({
    format: z.literal("zamer-project"),
    packageVersion: z.union([z.literal(1), z.literal(2)]),
    createdAt: z.iso.datetime(),
    source: snapshot,
    prices: z.array(price).max(10000),
    excludedIds: z.array(z.string().max(128)).max(50000),
    originals: z.array(file).max(20000),
    documents: z.array(report).max(1000),
    artifacts: z.array(file).max(10000),
    warnings: z.array(z.string().max(2000)).max(1000),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (
      p.packageVersion === 1 &&
      (p.documents.some((d) => d.format === "xlsx") ||
        [
          ...p.originals,
          ...p.artifacts,
          ...p.documents.flatMap((d) => d.files),
        ].some((f) => f.mimeType === XLSX_MIME))
    )
      ctx.addIssue({ code: "custom", message: "XLSX требует версию пакета 2" });
  });
export type PortableProject = z.infer<typeof packageSchema>;
export interface DecodedProject {
  manifest: PortableProject;
  files: Map<string, Uint8Array>;
  jsonOnly: boolean;
}
export const PROJECT_JSON = "06_Исходные_данные/project.json";
export async function parsePackage(
  input: unknown,
  files: Map<string, Uint8Array>,
  jsonOnly = false,
): Promise<DecodedProject> {
  // Legacy v1–v5 project.json is still accepted as geometry-only data.
  const manifest =
    typeof input === "object" && input !== null && "schemaVersion" in input
      ? ({
          format: "zamer-project",
          packageVersion: 1,
          createdAt: new Date().toISOString(),
          source: parseSnapshot(input),
          prices: [],
          excludedIds: [],
          originals: [],
          documents: [],
          artifacts: [],
          warnings: [],
        } satisfies PortableProject)
      : packageSchema.parse(input);
  if (!manifest.source.floors.length) throw new Error("В проекте нет этажей");
  if (
    manifest.source.walls.length > 5000 ||
    manifest.source.elements.length > 5000 ||
    manifest.source.rooms.length > 2000
  )
    throw new Error("Импорт превышает допустимое количество элементов");
  const entries = [
      ...manifest.originals,
      ...manifest.documents.flatMap((d) => d.files),
      ...manifest.artifacts,
    ],
    paths = new Set<string>();
  for (const entry of entries) {
    assertPath(entry.path);
    const key = entry.path.toLowerCase();
    if (paths.has(key) || entry.path === PROJECT_JSON)
      throw new Error("Повтор пути в манифесте");
    paths.add(key);
    if (!jsonOnly) {
      const bytes = files.get(entry.path);
      if (
        !bytes ||
        bytes.length !== entry.size ||
        (await checksum(new Blob([new Uint8Array(bytes).buffer]))) !==
          entry.checksum
      )
        throw new Error("Отсутствует или повреждён файл: " + entry.path);
    }
  }
  const sources = [manifest.source, ...manifest.documents.map((d) => d.source)],
    byChecksum = new Map(manifest.originals.map((f) => [f.checksum, f]));
  for (const s of sources)
    for (const p of s.photos) {
      const entry = byChecksum.get(p.checksum);
      if (
        !jsonOnly &&
        (!entry || entry.size !== p.size || entry.mimeType !== p.mimeType)
      )
        throw new Error("Архив не содержит оригинал фото: " + p.originalName);
    }
  const reportIds = new Set<string>();
  const priceKeys = new Set<string>();
  for (const p of manifest.prices) {
    const key = JSON.stringify([
      p.name.normalize("NFC").toLocaleLowerCase("ru-RU"),
      p.unit,
    ]);
    if (priceKeys.has(key)) throw new Error("Повтор цены вида работ");
    priceKeys.add(key);
  }
  for (const d of manifest.documents) {
    if (
      d.source.project.id !== manifest.source.project.id ||
      reportIds.has(d.id) ||
      (d.scope.floorId &&
        !d.source.floors.some((f) => f.id === d.scope.floorId)) ||
      (d.scope.roomId && !d.source.rooms.some((r) => r.id === d.scope.roomId))
    )
      throw new Error("Некорректный исторический документ");
    reportIds.add(d.id);
    if (
      d.files.some(
        (f) =>
          f.mimeType !==
          (d.format === "pdf"
            ? "application/pdf"
            : d.format === "xlsx"
              ? XLSX_MIME
              : "image/jpeg"),
      )
    )
      throw new Error("Неверный формат исторического файла");
  }
  if (!jsonOnly)
    for (const name of files.keys())
      if (name !== PROJECT_JSON && !paths.has(name.toLowerCase()))
        throw new Error("Файл отсутствует в манифесте: " + name);
  return { manifest, files, jsonOnly };
}
export async function decodeProject(bytes: Uint8Array, isJson = false) {
  if (isJson) {
    if (bytes.length > 20 * 1024 * 1024)
      throw new Error("project.json превышает 20 МБ");
    return parsePackage(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      new Map(),
      true,
    );
  }
  const files = readZip(bytes),
    json = files.get(PROJECT_JSON);
  if (!json || json.length > 20 * 1024 * 1024)
    throw new Error("В ZIP нет допустимого project.json");
  return parsePackage(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json)),
    files,
  );
}
