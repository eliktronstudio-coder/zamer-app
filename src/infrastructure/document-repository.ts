import { ProjectRepository, type ZamerDatabase } from "./database";
import { cloudTables, projectSnapshot } from "./cloud-repository";
import {
  priceKey,
  type SavedReport,
  type Unit,
  type WorkPrice,
} from "../features/documents/model";
import { checksum } from "./media-repository";
export class DocumentRepository {
  constructor(readonly db: ZamerDatabase) {}
  async load(projectId: string) {
    const ownerId = this.db.currentOwnerId;
    return this.db.transaction(
      "r",
      [
        ...cloudTables(this.db),
        this.db.workPrices,
        this.db.documents,
        this.db.estimateSettings,
        this.db.projectWorkPrices,
      ],
      async () => {
        const project = await new ProjectRepository(this.db).get(projectId);
        if (!project || project.status !== "active")
          throw new Error("Объект недоступен");
        const source = await projectSnapshot(this.db, projectId);
        const prices = (await this.db.workPrices.toArray()).filter(
          (p) => p.ownerId === ownerId,
        );
        const overrides = (
          await this.db.projectWorkPrices.where({ projectId }).toArray()
        ).filter((p) => p.ownerId === ownerId);
        for (const p of overrides) {
          const id = priceKey(ownerId, p.name, p.unit),
            index = prices.findIndex((v) => v.id === id),
            price = {
              id,
              ownerId,
              name: p.name,
              unit: p.unit,
              kopecks: p.kopecks,
              updatedAt: p.updatedAt,
            };
          if (index >= 0) prices[index] = price;
          else prices.push(price);
        }
        const documents = (
          await this.db.documents.where({ projectId }).toArray()
        )
          .filter((d) => d.ownerId === ownerId || d.ownerId === null)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const photos = await this.db.photoFiles
          .where("checksum")
          .anyOf(
            source.photos.filter((p) => !p.deletedAt).map((p) => p.checksum),
          )
          .toArray();
        const excludedIds =
          (
            await this.db.estimateSettings.get(
              JSON.stringify([projectId, ownerId]),
            )
          )?.excludedIds ?? [];
        return {
          source,
          prices,
          documents,
          photos,
          ownerId,
          excludedIds,
          hasImportedPrices: overrides.length > 0,
        };
      },
    );
  }
  async setPrice(
    name: string,
    unit: Unit,
    kopecks: number | null,
    projectId?: string,
  ) {
    if (
      !name.trim() ||
      name.length > 500 ||
      !["m", "m2", "m3", "pcs"].includes(unit) ||
      (kopecks !== null &&
        (!Number.isSafeInteger(kopecks) ||
          kopecks < 0 ||
          kopecks > 1_000_000_000_000))
    )
      throw new Error("Недопустимая цена");
    const ownerId = this.db.currentOwnerId,
      id = priceKey(ownerId, name, unit);
    await this.db.transaction(
      "rw",
      [this.db.workPrices, this.db.projectWorkPrices, this.db.projects],
      async () => {
        const project = projectId
          ? await new ProjectRepository(this.db).get(projectId)
          : undefined;
        if (this.db.currentOwnerId !== ownerId)
          throw new Error("Аккаунт изменился");
        if (projectId && (!project || project.status !== "active"))
          throw new Error("Объект недоступен");
        if (projectId)
          await this.db.projectWorkPrices.delete(
            JSON.stringify([projectId, id]),
          );
        if (kopecks === null) await this.db.workPrices.delete(id);
        else
          await this.db.workPrices.put({
            id,
            ownerId,
            name: name.trim(),
            unit,
            kopecks,
            updatedAt: new Date().toISOString(),
          } satisfies WorkPrice);
      },
    );
  }
  async setExcluded(projectId: string, excludedIds: string[]) {
    const ownerId = this.db.currentOwnerId;
    if (
      excludedIds.length > 50000 ||
      excludedIds.some((id) => typeof id !== "string" || id.length > 128)
    )
      throw new Error("Недопустимый состав сметы");
    await this.db.transaction(
      "rw",
      [this.db.projects, this.db.estimateSettings],
      async () => {
        const p = await new ProjectRepository(this.db).get(projectId);
        if (!p || p.status !== "active") throw new Error("Объект недоступен");
        if (this.db.currentOwnerId !== ownerId)
          throw new Error("Аккаунт изменился");
        await this.db.estimateSettings.put({
          id: JSON.stringify([projectId, ownerId]),
          projectId,
          ownerId,
          excludedIds: [...new Set(excludedIds)].sort(),
        });
      },
    );
  }
  async save(report: SavedReport) {
    await this.db.transaction(
      "rw",
      [this.db.projects, this.db.documents],
      async () => {
        const p = await new ProjectRepository(this.db).get(report.projectId);
        if (
          !p ||
          p.status !== "active" ||
          this.db.currentOwnerId !== report.ownerId
        )
          throw new Error("Аккаунт или объект изменился; документ не сохранён");
        if (!report.files.length || report.files.some((f) => !f.blob.size))
          throw new Error("Пустой документ");
        await this.db.documents.add(report);
      },
    );
  }
}
export async function documentFingerprint(
  source: SavedReport["source"],
  prices: WorkPrice[],
  excludedIds: string[] = [],
) {
  return checksum(
    new Blob([
      JSON.stringify([
        source,
        [...excludedIds].sort(),
        [...prices].sort((a, b) => a.id.localeCompare(b.id)),
      ]),
    ]),
  );
}
