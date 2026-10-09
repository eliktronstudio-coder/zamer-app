import type { GeometryScene } from "../geometry/constraints";
export type SaveStatus = "saved" | "pending" | "saving" | "error" | "conflict";
export interface SaveNotification {
  status: SaveStatus;
  backupAvailable: boolean;
}
export interface SavePort {
  save: (scene: GeometryScene, revision: number) => Promise<number>;
  backup: (scene: GeometryScene) => Promise<void>;
  notify: (notification: SaveNotification) => void;
}
// Serial writes, latest pending scene, retained until storage acknowledges it.
export class SaveQueue {
  private pending: GeometryScene | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flight: Promise<void> | null = null;
  private blocked: SaveStatus | null = null;
  private backupAvailable = false;
  constructor(
    private revision: number,
    private port: SavePort,
    private debounceMs = 250,
  ) {}
  get dirty() {
    return this.pending !== null;
  }
  schedule(scene: GeometryScene) {
    this.pending = scene;
    this.backupAvailable = false;
    this.port.notify({
      status: this.blocked ?? "pending",
      backupAvailable: false,
    });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.flight) {
      await this.flight;
      if (this.pending && !this.blocked) return this.flush();
      return;
    }
    this.flight = this.drain();
    try {
      await this.flight;
    } finally {
      this.flight = null;
    }
  }
  private async drain() {
    while (this.pending) {
      const scene = this.pending;
      if (!this.blocked) {
        this.port.notify({ status: "saving", backupAvailable: false });
        try {
          this.revision = await this.port.save(scene, this.revision);
          if (this.pending === scene) this.pending = null;
          continue;
        } catch (error) {
          this.blocked =
            error instanceof Error && error.name === "SceneConflictError"
              ? "conflict"
              : "error";
        }
      }
      try {
        await this.port.backup(scene);
        this.backupAvailable = this.pending === scene;
      } catch {
        this.backupAvailable = false;
      }
      this.port.notify({
        status: this.blocked!,
        backupAvailable: this.backupAvailable,
      });
      if (this.pending !== scene) continue;
      return;
    }
    this.port.notify({ status: "saved", backupAvailable: false });
  }
  acknowledgeScene(scene: GeometryScene) {
    if (this.pending !== scene) return;
    clearTimeout(this.timer);
    this.pending = null;
    this.blocked = null;
    this.backupAvailable = false;
  }
  async retry() {
    if (this.blocked === "conflict") return;
    this.blocked = null;
    await this.flush();
  }
}
