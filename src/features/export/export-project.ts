import { renderXlsx, XLSX_MIME } from "../documents/xlsx";
import type { ZamerDatabase } from "../../infrastructure/database";
import { DocumentRepository } from "../../infrastructure/document-repository";
import { checksum } from "../../infrastructure/media-repository";
import { buildStatement, priceKey } from "../documents/model";
import { renderReport } from "../documents/render";
import { planImage, viewImage } from "../documents/images";
import { packageSchema, PROJECT_JSON, type PortableProject } from "./package";
import { createZip } from "./zip";
import { segment, MAX_ARCHIVE, MAX_ENTRY } from "./paths";
const entityName = (name: string, id: string) =>
  `${segment(name).slice(0, 60)}_${id}`;
const priceData = (p: {
  name: string;
  unit: "m" | "m2" | "m3" | "pcs";
  kopecks: number;
}) => ({ name: p.name, unit: p.unit, kopecks: p.kopecks });
async function jpeg(data: string) {
  const image = new Image();
  image.src = data;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas недоступен");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);
  const blob = await new Promise<Blob | null>((r) =>
    canvas.toBlob(r, "image/jpeg", 0.92),
  );
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error("Не удалось сформировать JPEG плана");
  return blob;
}
export async function exportProject(
  db: ZamerDatabase,
  projectId: string,
  onProgress: (text: string) => void = () => {},
) {
  onProgress("Читаем сохранённый проект…");
  const data = await new DocumentRepository(db).load(projectId),
    ownerId = data.ownerId,
    source = data.source;
  // Snapshot metadata is atomic; immutable originals are addressed and verified by checksum.
  const checksums = [
    ...new Set(
      [...source.photos, ...data.documents.flatMap((d) => d.source.photos)].map(
        (p) => p.checksum,
      ),
    ),
  ];
  const originals = await db.photoFiles
    .where("checksum")
    .anyOf(checksums)
    .toArray();
  if (db.currentOwnerId !== ownerId) throw new Error("Аккаунт изменился");
  const verified = new Set<string>();
  for (const photo of [
    ...source.photos,
    ...data.documents.flatMap((d) => d.source.photos),
  ]) {
    const file = originals.find((f) => f.checksum === photo.checksum);
    if (!file)
      throw new Error(
        `Оригинал «${photo.originalName}» не загружен. Загрузите его в разделе фото перед полным экспортом.`,
      );
    if (
      file.original.size !== photo.size ||
      (!verified.has(photo.checksum) &&
        (await checksum(file.original)) !== photo.checksum)
    )
      throw new Error("Оригинал повреждён: " + photo.originalName);
    verified.add(photo.checksum);
    onProgress(`Проверены оригиналы: ${verified.size} / ${checksums.length}`);
  }
  const used = new Set(
      buildStatement(source).rows.map((r) => priceKey(ownerId, r.name, r.unit)),
    ),
    files = new Map<string, Uint8Array>();
  let size = 0;
  const manifest: PortableProject = {
    format: "zamer-project",
    packageVersion: 2,
    createdAt: new Date().toISOString(),
    source,
    prices: data.prices.filter((p) => used.has(p.id)).map(priceData),
    excludedIds: data.excludedIds,
    originals: [],
    documents: [],
    artifacts: [],
    warnings: [],
  };
  const add = async (path: string, blob: Blob) => {
    size += blob.size;
    if (blob.size > MAX_ENTRY || size > MAX_ARCHIVE - 4 * 1024 * 1024)
      throw new Error(
        "Проект превышает лимит ZIP 256 МБ; файлы не исключаются автоматически",
      );
    if (files.has(path)) throw new Error("Повтор пути экспорта");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    files.set(path, bytes);
    return {
      path,
      checksum: await checksum(blob),
      size: blob.size,
      mimeType: blob.type as PortableProject["artifacts"][number]["mimeType"],
    };
  };
  onProgress("Проверяем оригиналы и фотографии…");
  const photos = [
    ...new Map(
      [...data.documents.flatMap((d) => d.source.photos), ...source.photos].map(
        (p) => [p.id, p],
      ),
    ).values(),
  ];
  for (const photo of photos) {
    const floor = source.floors.find((f) => f.id === photo.floorId),
      room = source.rooms.find((r) => r.id === photo.roomId);
    const floorName = photo.floorId
        ? entityName(floor?.name ?? "Этаж", photo.floorId)
        : "Объект",
      roomName = photo.roomId
        ? entityName(room?.name ?? "Помещение", photo.roomId)
        : "Без_помещения";
    const extension =
      photo.mimeType.split("/")[1] === "jpeg"
        ? "jpg"
        : photo.mimeType.split("/")[1];
    const path = `05_Фотографии/${photo.deletedAt ? "Корзина/" : ""}${floorName}/${roomName}/${entityName(photo.originalName, photo.id)}.${extension}`;
    manifest.originals.push(
      await add(
        path,
        new Blob(
          [originals.find((f) => f.checksum === photo.checksum)!.original],
          { type: photo.mimeType },
        ),
      ),
    );
  }
  for (const doc of data.documents) {
    const entries = [];
    for (let i = 0; i < doc.files.length; i++) {
      const f = doc.files[i];
      entries.push(
        await add(
          `00_Общий_отчет/История/${doc.id}/${String(i + 1).padStart(3, "0")}_${segment(f.name)}`,
          new Blob([f.blob], {
            type:
              doc.format === "pdf"
                ? "application/pdf"
                : doc.format === "xlsx"
                  ? XLSX_MIME
                  : "image/jpeg",
          }),
        ),
      );
    }
    manifest.documents.push({
      id: doc.id,
      createdAt: doc.createdAt,
      title: doc.title,
      sourceRevision: doc.sourceRevision,
      sourceFingerprint: doc.sourceFingerprint,
      sections: doc.sections,
      scope: doc.scope,
      format: doc.format,
      pageCount: doc.pageCount,
      source: doc.source,
      prices: doc.prices
        .filter((p) =>
          doc.rows.some(
            (r) =>
              priceKey(null, r.name, r.unit) === priceKey(null, p.name, p.unit),
          ),
        )
        .map(priceData),
      excludedIds: doc.excludedIds ?? [],
      rows: doc.rows,
      files: entries,
    });
  }
  const specs: [string, Parameters<typeof renderReport>[4]][] = [
    [
      "00_Общий_отчет/report.pdf",
      [
        "summary",
        "rooms",
        "quantities",
        "defects",
        "estimate",
        "photos",
        "issues",
      ],
    ],
    ["03_Дефектная_ведомость/defects.pdf", ["defects", "photos"]],
    ["04_Смета/estimate.pdf", ["estimate"]],
  ];
  for (const [path, sections] of specs) {
    onProgress("Формируем " + path);
    const result = await renderReport(
      source,
      data.prices,
      ownerId,
      { floorId: null, roomId: null },
      sections,
      originals,
      "pdf",
      data.excludedIds,
    );
    manifest.artifacts.push(await add(path, result.files[0].blob));
  }
  for (const [path, sections] of [
    ["03_Дефектная_ведомость/defects.xlsx", ["defects"]],
    ["04_Смета/estimate.xlsx", ["estimate"]],
  ] as const) {
    onProgress("Формируем " + path);
    const result = renderXlsx(
      source,
      data.prices,
      ownerId,
      { floorId: null, roomId: null },
      [...sections],
      data.excludedIds,
    );
    manifest.artifacts.push(await add(path, result.files[0].blob));
  }
  for (const a of buildStatement(source).analyses) {
    onProgress("Планы и 3D: " + a.floor.name);
    const path = entityName(a.floor.name, a.floor.id);
    manifest.artifacts.push(
      await add(
        `01_Планы/${path}.jpg`,
        await jpeg(
          planImage(
            a.scene,
            a.floor,
            source.defects.filter(
              (d) => d.floorId === a.floor.id && !d.deletedAt,
            ),
          ),
        ),
      ),
    );
    const view = await viewImage(a.scene, a.floor);
    if (view)
      manifest.artifacts.push(await add(`02_3D/${path}.jpg`, await jpeg(view)));
    else
      manifest.warnings.push(
        `3D «${a.floor.name}»: WebGL недоступен; геометрия сохранена в project.json.`,
      );
  }
  if (!manifest.originals.length)
    manifest.artifacts.push(
      await add(
        "05_Фотографии/README.txt",
        new Blob(["В этом снимке проекта нет фотографий."], {
          type: "text/plain",
        }),
      ),
    );
  if (manifest.warnings.length)
    manifest.artifacts.push(
      await add(
        "02_3D/README.txt",
        new Blob([manifest.warnings.join("\n")], { type: "text/plain" }),
      ),
    );
  if (db.currentOwnerId !== ownerId)
    throw new Error("Аккаунт изменился; повторите экспорт");
  const json = new TextEncoder().encode(
    JSON.stringify(packageSchema.parse(manifest), null, 2),
  );
  if (json.length > 20 * 1024 * 1024)
    throw new Error("project.json превышает 20 МБ");
  files.set(PROJECT_JSON, json);
  onProgress("Собираем ZIP…");
  return {
    blob: new Blob([new Uint8Array(createZip(files)).buffer], {
      type: "application/zip",
    }),
    name: segment(source.project.name) + ".zip",
    warnings: manifest.warnings,
  };
}
