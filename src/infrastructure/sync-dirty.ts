import type { ZamerDatabase } from "./database";
import type { Project } from "../domain/model";
/** Called inside the same write transaction as the local mutation. */
export async function markCloudDirty(db: ZamerDatabase, project: Project) {
  const state = await db.cloudStates.get(project.id);
  if (!state) return;
  if (project.ownerId !== state.ownerId)
    throw new Error("Объект принадлежит другому аккаунту");
  await db.cloudStates.put({
    ...state,
    status: state.status === "conflict" ? "conflict" : "pending",
  });
  await db.outbox.put({
    id: crypto.randomUUID(),
    projectId: project.id,
    ownerId: state.ownerId,
    localRevision: project.revision,
    baseRevision: state.baseRevision,
    snapshot: null,
    attempts: 0,
    nextAttemptAt: 0,
    error: null,
  });
}
