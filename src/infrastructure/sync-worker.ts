import type { ProjectSnapshot } from "../domain/model";
import type { OutboxEntry } from "./sync-model";
import type { CloudRepository } from "./cloud-repository";
export interface SyncTransport {
  push(
    entry: OutboxEntry,
  ): Promise<
    | { type: "ack"; revision: number }
    | { type: "conflict"; revision: number; snapshot: ProjectSnapshot }
  >;
  list(): Promise<{ revision: number; snapshot: ProjectSnapshot }[]>;
}
export class SyncWorker {
  private running = false;
  private stopped = false;
  constructor(
    readonly repository: CloudRepository,
    readonly ownerId: string,
    readonly transport: SyncTransport,
  ) {}
  stop() {
    this.stopped = true;
  }
  async run() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      for (let i = 0; i < 100 && !this.stopped; i++) {
        this.repository.assertOwner(this.ownerId);
        const entry = await this.repository.prepare(this.ownerId);
        if (!entry) break;
        try {
          const result = await this.transport.push(entry);
          if (this.stopped) return;
          if (result.type === "ack")
            await this.repository.ack(entry, result.revision);
          else
            await this.repository.conflict(
              entry,
              result.snapshot,
              result.revision,
            );
        } catch (error) {
          if (this.stopped) return;
          await this.repository.failed(
            entry,
            error instanceof Error ? error.message : "Ошибка сети",
          );
          break;
        }
      }
    } finally {
      this.running = false;
    }
  }
  async pull() {
    if (this.stopped) return;
    for (const remote of await this.transport.list()) {
      if (this.stopped) return;
      await this.repository.download(
        remote.snapshot,
        remote.revision,
        this.ownerId,
      );
    }
  }
}
