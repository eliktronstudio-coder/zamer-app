import type { ZamerDatabase, PhotoFile } from "./database";
import type { DecodedProject } from "../features/export/package";
import { cloneSnapshot } from "./cloud-repository";
import { photoPreview } from "./media-repository";
import { priceKey, type SavedReport } from "../features/documents/model";
export async function importProject(
  db: ZamerDatabase,
  decoded: DecodedProject,
  name: string,
) {
  if (!name.trim() || name.trim().length > 160)
    throw new Error("Название копии должно содержать от 1 до 160 символов");
  const ownerId = db.currentOwnerId,
    { manifest, files, jsonOnly } = decoded,
    source = manifest.source,
    copy = cloneSnapshot(source, name.trim());
  const ids = new Map<string, string>();
  for (const key of [
    "floors",
    "walls",
    "elements",
    "rooms",
    "dimensions",
    "junctions",
    "defects",
    "photos",
  ] as const)
    source[key].forEach((entry, i) => ids.set(entry.id, copy[key][i].id));
  const excluded = manifest.excludedIds.map((id) => {
    const [prefix, ...parts] = id.split(":");
    return `${ids.get(prefix) ?? prefix}:${parts.join(":")}`;
  });
  const originals: PhotoFile[] = [];
  if (!jsonOnly)
    for (const original of manifest.originals) {
      const blob = new Blob(
        [new Uint8Array(files.get(original.path)!).buffer],
        { type: original.mimeType },
      );
      originals.push({
        checksum: original.checksum,
        original: blob,
        preview: await photoPreview(blob),
      });
    }
  const reports: SavedReport[] = jsonOnly
    ? []
    : manifest.documents.map((d) => ({
        ...d,
        id: crypto.randomUUID(),
        projectId: copy.project.id,
        ownerId,
        prices: d.prices.map((p) => ({
          ...p,
          id: priceKey(ownerId, p.name, p.unit),
          ownerId,
          updatedAt: d.createdAt,
        })),
        files: d.files.map((f) => ({
          name: f.path.split("/").at(-1)!,
          blob: new Blob([new Uint8Array(files.get(f.path)!).buffer], {
            type: f.mimeType,
          }),
        })),
      }));
  if (!copy.project.name || copy.project.name.length > 160)
    throw new Error("Название копии должно содержать от 1 до 160 символов");
  await db.transaction(
    "rw",
    [
      db.projects,
      db.floors,
      db.walls,
      db.elements,
      db.rooms,
      db.dimensions,
      db.junctions,
      db.defects,
      db.photos,
      db.photoFiles,
      db.sceneRevisions,
      db.documents,
      db.projectWorkPrices,
      db.estimateSettings,
    ],
    async () => {
      if (db.currentOwnerId !== ownerId)
        throw new Error("Аккаунт изменился во время импорта");
      await db.projects.add(copy.project);
      await db.floors.bulkAdd(copy.floors);
      await db.walls.bulkAdd(copy.walls);
      await db.elements.bulkAdd(copy.elements);
      await db.rooms.bulkAdd(copy.rooms);
      await db.dimensions.bulkAdd(copy.dimensions);
      await db.junctions.bulkAdd(copy.junctions);
      await db.defects.bulkAdd(copy.defects);
      await db.photos.bulkAdd(copy.photos);
      for (const file of originals) {
        const existing = await db.photoFiles.get(file.checksum);
        await db.photoFiles.put({
          ...file,
          preview: file.preview ?? existing?.preview ?? null,
        });
      }
      await db.sceneRevisions.bulkAdd(
        copy.floors.map((f) => ({ floorId: f.id, revision: 0 })),
      );
      await db.documents.bulkAdd(reports);
      await db.projectWorkPrices.bulkAdd(
        manifest.prices.map((p) => ({
          ...p,
          projectId: copy.project.id,
          ownerId,
          updatedAt: new Date().toISOString(),
          id: JSON.stringify([
            copy.project.id,
            priceKey(ownerId, p.name, p.unit),
          ]),
        })),
      );
      await db.estimateSettings.add({
        id: JSON.stringify([copy.project.id, ownerId]),
        projectId: copy.project.id,
        ownerId,
        excludedIds: excluded,
      });
    },
  );
  return copy;
}
