import {
  defectSchema,
  photoSchema,
  type Defect,
  type Binding,
} from "../domain/model";
import type { ZamerDatabase } from "./database";
import { markCloudDirty } from "./sync-dirty";
export const MAX_PHOTO_SIZE = 50 * 1024 * 1024;
export async function checksum(blob: Blob) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export function defectQuantities(
  d: Pick<Defect, "length" | "width" | "depth">,
) {
  const area =
    d.length !== null && d.width !== null ? d.length * d.width : null;
  const volume = area !== null && d.depth !== null ? area * d.depth : null;
  return {
    area: area !== null && Number.isFinite(area) ? area : null,
    volume: volume !== null && Number.isFinite(volume) ? volume : null,
  };
}
export async function photoPreview(original: Blob): Promise<Blob | null> {
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(original);
    const ratio = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height)),
      canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.8),
    );
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}
export class MediaRepository {
  constructor(readonly db: ZamerDatabase) {}
  tables() {
    return [
      this.db.projects,
      this.db.floors,
      this.db.rooms,
      this.db.walls,
      this.db.elements,
      this.db.defects,
      this.db.photos,
      this.db.photoFiles,
      this.db.photoTransfers,
      this.db.cloudStates,
      this.db.outbox,
    ];
  }
  async access(projectId: string, write = false) {
    const p = await this.db.projects.get(projectId);
    if (
      !p ||
      (p.ownerId !== null && p.ownerId !== this.db.currentOwnerId) ||
      (write && p.status !== "active")
    )
      throw new Error("Объект недоступен этому аккаунту");
    return p;
  }
  async binding(b: Binding) {
    if (
      b.floorId &&
      (await this.db.floors.get(b.floorId))?.projectId !== b.projectId
    )
      throw new Error("Этаж другого объекта");
    if (
      b.roomId &&
      (!b.floorId || (await this.db.rooms.get(b.roomId))?.floorId !== b.floorId)
    )
      throw new Error("Помещение другого этажа");
    if (
      b.elementId &&
      (!b.floorId ||
        (
          (await this.db.walls.get(b.elementId)) ??
          (await this.db.elements.get(b.elementId))
        )?.floorId !== b.floorId)
    )
      throw new Error("Элемент другого этажа");
  }
  async dirty(projectId: string) {
    const p = await this.access(projectId, true),
      next = {
        ...p,
        revision: p.revision + 1,
        updatedAt: new Date().toISOString(),
      };
    await this.db.projects.put(next);
    await markCloudDirty(this.db, next);
  }
  async list(projectId: string) {
    return this.db.transaction("r", this.tables(), async () => {
      await this.access(projectId);
      return {
        defects: await this.db.defects.where({ projectId }).toArray(),
        photos: await this.db.photos.where({ projectId }).toArray(),
      };
    });
  }
  async saveDefect(input: Defect, baseRevision: number | null) {
    const d = defectSchema.parse(input);
    return this.db.transaction("rw", this.tables(), async () => {
      await this.access(d.projectId, true);
      const old = await this.db.defects.get(d.id);
      if (old && old.projectId !== d.projectId)
        throw new Error("Дефект другого объекта");
      if ((old?.revision ?? null) !== baseRevision)
        throw new Error(
          "Дефект изменён в другой вкладке. Откройте его заново.",
        );
      // Historical bindings survive removal of their target; new bindings must resolve.
      if (
        !old ||
        old.floorId !== d.floorId ||
        old.roomId !== d.roomId ||
        old.elementId !== d.elementId
      )
        await this.binding(d);
      const saved = {
        ...d,
        revision: (old?.revision ?? -1) + 1,
        updatedAt: new Date().toISOString(),
      };
      await this.db.defects.put(saved);
      await this.db.photos.where({ defectId: d.id }).modify({
        floorId: d.floorId,
        roomId: d.roomId,
        elementId: d.elementId,
      });
      await this.dirty(d.projectId);
      return saved;
    });
  }
  async addPhoto(
    file: File,
    b: Binding & { defectId: string | null },
    caption = "",
  ) {
    if (!file.size || file.size > MAX_PHOTO_SIZE)
      throw new Error("Размер фото должен быть от 1 байта до 50 МБ");
    const mime =
      file.type ||
      ({ heic: "image/heic", heif: "image/heif" } as Record<string, string>)[
        file.name.split(".").at(-1)!.toLowerCase()
      ];
    if (
      ![
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/heic",
        "image/heif",
      ].includes(mime)
    )
      throw new Error("Поддерживаются JPEG, PNG, WebP, HEIC и HEIF");
    const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    const ascii = (start: number, end: number) =>
      String.fromCharCode(...header.slice(start, end));
    const valid =
      mime === "image/jpeg"
        ? header[0] === 255 && header[1] === 216 && header[2] === 255
        : mime === "image/png"
          ? header.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10"
          : mime === "image/webp"
            ? ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP"
            : ascii(4, 8) === "ftyp" &&
              ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].some((brand) =>
                ascii(8, 32).includes(brand),
              );
    if (!valid)
      throw new Error("Содержимое файла не соответствует формату фото");
    const original = new Blob([await file.arrayBuffer()], { type: mime }),
      hash = await checksum(original),
      preview = await photoPreview(original),
      id = crypto.randomUUID();
    const photo = photoSchema.parse({
      ...b,
      id,
      caption,
      storageKey: `${b.projectId}/${id}/${hash}`,
      checksum: hash,
      originalName: file.name,
      mimeType: mime,
      size: file.size,
      createdAt: new Date().toISOString(),
      sourceModifiedAt: file.lastModified,
      deletedAt: null,
    });
    await this.db.transaction("rw", this.tables(), async () => {
      await this.access(b.projectId, true);
      await this.binding(b);
      if (b.defectId) {
        const d = await this.db.defects.get(b.defectId);
        if (
          !d ||
          d.deletedAt ||
          d.projectId !== b.projectId ||
          d.floorId !== b.floorId ||
          d.roomId !== b.roomId ||
          d.elementId !== b.elementId
        )
          throw new Error("Фото не соответствует привязкам дефекта");
      }
      if (
        (await this.db.photos.where({ projectId: b.projectId }).count()) >= 2000
      )
        throw new Error("Лимит объекта — 2000 фотографий");
      const existing = await this.db.photoFiles.get(hash);
      if (!existing)
        await this.db.photoFiles.put({ checksum: hash, original, preview });
      await this.db.photos.add(photo);
      await this.dirty(b.projectId);
    });
    return photo;
  }
  async setPhotoDeleted(id: string, deleted: boolean) {
    return this.db.transaction("rw", this.tables(), async () => {
      const p = await this.db.photos.get(id);
      if (!p) throw new Error("Фото не найдено");
      await this.access(p.projectId, true);
      await this.db.photos.put({
        ...p,
        deletedAt: deleted ? new Date().toISOString() : null,
      });
      await this.dirty(p.projectId);
    });
  }
  async file(id: string) {
    return this.db.transaction("r", this.tables(), async () => {
      const p = await this.db.photos.get(id);
      if (!p) throw new Error("Фото не найдено");
      await this.access(p.projectId);
      return this.db.photoFiles.get(p.checksum);
    });
  }
  async cacheOriginal(id: string, blob: Blob) {
    const p = await this.db.photos.get(id);
    if (!p) throw new Error("Фото не найдено");
    await this.access(p.projectId);
    if (blob.size !== p.size || (await checksum(blob)) !== p.checksum)
      throw new Error("Оригинал не прошёл проверку целостности");
    const preview = await photoPreview(blob);
    await this.db.transaction("rw", this.tables(), async () => {
      await this.access(p.projectId);
      await this.db.photoFiles.put({
        checksum: p.checksum,
        original: blob,
        preview,
      });
    });
  }
  async report(projectId: string) {
    const data = await this.list(projectId);
    return data.defects
      .filter((d) => !d.deletedAt)
      .map((d) => ({
        ...d,
        ...defectQuantities(d),
        photos: data.photos.filter((p) => p.defectId === d.id && !p.deletedAt),
      }));
  }
}
