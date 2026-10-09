import type { ProjectSnapshot } from "../domain/model";
export interface CloudState {
  projectId: string;
  ownerId: string;
  baseRevision: number;
  ackLocalRevision: number;
  status: "pending" | "synced" | "conflict";
  lastSyncedAt: string | null;
}
export interface OutboxEntry {
  id: string;
  projectId: string;
  ownerId: string;
  localRevision: number;
  baseRevision: number;
  snapshot: ProjectSnapshot | null;
  attempts: number;
  nextAttemptAt: number;
  error: string | null;
}
export interface CloudConflict {
  projectId: string;
  ownerId: string;
  local: ProjectSnapshot;
  remote: ProjectSnapshot;
  remoteRevision: number;
  createdAt: string;
}
