import { markCloudDirty } from "./sync-dirty";
import type { CloudState, OutboxEntry, CloudConflict } from "./sync-model";
import Dexie, { type EntityTable } from "dexie";
import type {
  WorkPrice,
  SavedReport,
  EstimateSettings,
} from "../features/documents/model";
import {
  floorSchema,
  type ConstructionElement,
  type Room,
  type Defect,
  type Photo,
  type Floor,
  type Project,
  type Wall,
  type Junction,
  type Dimension,
  projectSchema,
} from "../domain/model";
import { createProject, changeStatus } from "../domain/projects";
import {
  SceneRepository,
  type SceneRevision,
  type RecoveryDraft,
} from "./scene-storage";
export interface PhotoFile {
  checksum: string;
  original: Blob;
  preview: Blob | null;
}
export interface PhotoTransfer {
  photoId: string;
  projectId: string;
  uploaded: boolean;
  checksum: string;
  storageKey: string;
  error: string | null;
}
export class ZamerDatabase extends Dexie {
  projectWorkPrices!: EntityTable<WorkPrice & { projectId: string }, "id">;
  workPrices!: EntityTable<WorkPrice, "id">;
  documents!: EntityTable<SavedReport, "id">;
  estimateSettings!: EntityTable<EstimateSettings, "id">;
  defects!: EntityTable<Defect, "id">;
  photos!: EntityTable<Photo, "id">;
  photoFiles!: EntityTable<PhotoFile, "checksum">;
  photoTransfers!: EntityTable<PhotoTransfer, "photoId">;
  currentOwnerId: string | null = null;
  cloudStates!: EntityTable<CloudState, "projectId">;
  outbox!: EntityTable<OutboxEntry, "id">;
  cloudConflicts!: EntityTable<CloudConflict, "projectId">;
  projects!: EntityTable<Project, "id">;
  floors!: EntityTable<Floor, "id">;
  rooms!: EntityTable<Room, "id">;
  elements!: EntityTable<ConstructionElement, "id">;
  walls!: EntityTable<Wall, "id">;
  junctions!: EntityTable<Junction, "id">;
  dimensions!: EntityTable<Dimension, "id">;
  sceneRevisions!: EntityTable<SceneRevision, "floorId">;
  recoveryDrafts!: EntityTable<RecoveryDraft, "id">;
  constructor(name = "zamer-local") {
    super(name);
    this.version(8).stores({ projectWorkPrices: "id,projectId,ownerId" });
    this.version(7).stores({
      estimateSettings: "id,projectId,ownerId",
      workPrices: "id,ownerId",
      documents: "id,projectId,ownerId,createdAt",
    });
    this.version(1).stores({
      projects: "id,status,updatedAt",
      floors: "id,projectId,[projectId+order]",
      walls: "id,floorId",
    });
    this.version(2)
      .stores({
        junctions: "id,floorId",
        dimensions: "id,floorId",
        sceneRevisions: "floorId",
        recoveryDrafts: "id,floorId,updatedAt",
      })
      .upgrade(async (tx) => {
        const floors: Floor[] = await tx.table("floors").toArray();
        await tx
          .table("sceneRevisions")
          .bulkPut(floors.map((f) => ({ floorId: f.id, revision: 0 })));
      });
    this.version(3)
      .stores({ elements: "id,floorId,kind,wallId" })
      .upgrade(async (tx) => {
        await tx
          .table("recoveryDrafts")
          .toCollection()
          .modify((draft: RecoveryDraft) => {
            draft.scene = {
              ...draft.scene,
              elements: draft.scene.elements ?? [],
            };
          });
      });
    this.version(4)
      .stores({ rooms: "id,floorId,status" })
      .upgrade(async (tx) => {
        await tx
          .table("recoveryDrafts")
          .toCollection()
          .modify((draft: RecoveryDraft) => {
            draft.scene = { ...draft.scene, rooms: draft.scene.rooms ?? [] };
          });
      });
    this.version(6).stores({
      defects: "id,projectId,floorId,roomId,elementId",
      photos: "id,projectId,floorId,defectId,checksum",
      photoFiles: "checksum",
      photoTransfers: "photoId,projectId,uploaded",
    });
    this.version(5).stores({
      cloudStates: "projectId,ownerId,status",
      outbox: "id,projectId,ownerId,nextAttemptAt",
      cloudConflicts: "projectId,ownerId",
    });
  }
}
export class ProjectRepository {
  constructor(readonly db: ZamerDatabase) {}
  async create(name: string, floorName: string) {
    const data = createProject(name, floorName);
    await this.db.transaction(
      "rw",
      this.db.projects,
      this.db.floors,
      async () => {
        await this.db.projects.add(data.project);
        await this.db.floors.add(data.floor);
      },
    );
    return data;
  }
  async list() {
    return (
      await this.db.projects.orderBy("updatedAt").reverse().toArray()
    ).filter((p) => p.ownerId === null || p.ownerId === this.db.currentOwnerId);
  }
  async get(id: string) {
    const project = await this.db.projects.get(id);
    return project &&
      (project.ownerId === null || project.ownerId === this.db.currentOwnerId)
      ? project
      : undefined;
  }
  async floors(projectId: string) {
    if (!(await this.get(projectId)))
      throw new Error("Объект недоступен этому аккаунту");
    return this.db.floors.where({ projectId }).sortBy("order");
  }
  async rename(id: string, name: string) {
    await this.db.transaction(
      "rw",
      [this.db.projects, this.db.cloudStates, this.db.outbox],
      async () => {
        const project = await this.get(id);
        if (!project) throw new Error("Объект не найден");
        await this.db.projects.put(
          projectSchema.parse({
            ...project,
            name,
            updatedAt: new Date().toISOString(),
            revision: project.revision + 1,
          }),
        );
        await markCloudDirty(this.db, (await this.db.projects.get(id))!);
      },
    );
  }
  async status(id: string, status: Project["status"]) {
    await this.db.transaction(
      "rw",
      [this.db.projects, this.db.cloudStates, this.db.outbox],
      async () => {
        const project = await this.get(id);
        if (!project) throw new Error("Объект не найден");
        await this.db.projects.put(changeStatus(project, status));
        await markCloudDirty(this.db, (await this.db.projects.get(id))!);
      },
    );
  }
  async addFloor(projectId: string, name: string) {
    return this.db.transaction(
      "rw",
      [this.db.projects, this.db.floors, this.db.cloudStates, this.db.outbox],
      async () => {
        const project = await this.get(projectId);
        if (!project || project.status !== "active")
          throw new Error("Объект недоступен");
        const floors = await this.floors(projectId);
        const floor = floorSchema.parse({
          id: crypto.randomUUID(),
          projectId,
          name,
          elevation: 0,
          defaultHeight: 2.7,
          order: Math.max(-1, ...floors.map((f) => f.order)) + 1,
        });
        await this.db.floors.add(floor);
        await this.db.projects.put({
          ...project,
          revision: project.revision + 1,
          updatedAt: new Date().toISOString(),
        });
        await markCloudDirty(this.db, (await this.db.projects.get(projectId))!);
        return floor;
      },
    );
  }
}
export const repository = new ProjectRepository(new ZamerDatabase());

export const sceneRepository = new SceneRepository(repository.db);
