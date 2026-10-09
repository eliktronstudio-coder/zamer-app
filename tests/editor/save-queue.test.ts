import { afterEach, describe, it, expect, vi } from "vitest";
import { SaveQueue, type SaveNotification } from "../../src/editor/save-queue";
import { scene, wall } from "../geometry/fixtures";
import { SceneConflictError } from "../../src/infrastructure/scene-storage";
afterEach(() => vi.useRealTimers());
describe("serial autosave queue", () => {
  it("debounces and writes only the latest command with the acknowledged revision", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(1);
    const queue = new SaveQueue(0, { save, backup: vi.fn(), notify: vi.fn() });
    queue.schedule(scene([wall(1)]));
    const latest = scene([wall(2)]);
    queue.schedule(latest);
    await vi.advanceTimersByTimeAsync(250);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(latest, 0);
    expect(queue.dirty).toBe(false);
  });
  it("serializes an edit arriving during an in-flight write", async () => {
    let complete!: (revision: number) => void;
    const first = new Promise<number>((resolve) => {
      complete = resolve;
    });
    const save = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(2);
    const queue = new SaveQueue(
      0,
      { save, backup: vi.fn(), notify: vi.fn() },
      10000,
    );
    queue.schedule(scene([wall(1)]));
    const flight = queue.flush();
    const latest = scene([wall(2)]);
    queue.schedule(latest);
    complete(1);
    await flight;
    expect(save.mock.calls[1]).toEqual([latest, 1]);
    expect(queue.dirty).toBe(false);
  });
  it("keeps an unacknowledged scene and persists a separate recovery copy on failure", async () => {
    const save = vi.fn().mockRejectedValue(new Error("quota"));
    const backup = vi.fn().mockResolvedValue(undefined);
    const notices: SaveNotification[] = [];
    const queue = new SaveQueue(
      0,
      { save, backup, notify: (value) => notices.push(value) },
      10000,
    );
    const latest = scene([wall(1)]);
    queue.schedule(latest);
    await queue.flush();
    expect(queue.dirty).toBe(true);
    expect(backup).toHaveBeenCalledWith(latest);
    expect(notices.at(-1)).toEqual({ status: "error", backupAvailable: true });
    queue.acknowledgeScene(latest);
  });
  it("never claims a backup succeeded if storage rejects it", async () => {
    const notify = vi.fn(),
      queue = new SaveQueue(
        0,
        {
          save: vi.fn().mockRejectedValue(new Error("quota")),
          backup: vi.fn().mockRejectedValue(new Error("quota")),
          notify,
        },
        10000,
      );
    const s = scene([wall(1)]);
    queue.schedule(s);
    await queue.flush();
    expect(notify).toHaveBeenLastCalledWith({
      status: "error",
      backupAvailable: false,
    });
    queue.acknowledgeScene(s);
  });
  it("does not retry a stale revision or silently replace the other tab", async () => {
    const save = vi.fn().mockRejectedValue(new SceneConflictError()),
      backup = vi.fn().mockResolvedValue(undefined),
      queue = new SaveQueue(0, { save, backup, notify: vi.fn() }, 10000);
    const s = scene([wall(1)]);
    queue.schedule(s);
    await queue.flush();
    await queue.retry();
    expect(save).toHaveBeenCalledTimes(1);
    const newer = scene([wall(2)]);
    queue.schedule(newer);
    await queue.flush();
    expect(backup).toHaveBeenLastCalledWith(newer);
    queue.acknowledgeScene(newer);
  });
  it("retries transient failures at the same revision and acknowledges only success", async () => {
    const save = vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary"))
        .mockResolvedValueOnce(4),
      queue = new SaveQueue(
        3,
        { save, backup: vi.fn().mockResolvedValue(undefined), notify: vi.fn() },
        10000,
      );
    queue.schedule(scene([wall(1)]));
    await queue.flush();
    await queue.retry();
    expect(save.mock.calls.map((c) => c[1])).toEqual([3, 3]);
    expect(queue.dirty).toBe(false);
  });
  it("does not discard newer edits when acknowledging an older recovered scene", async () => {
    const queue = new SaveQueue(
        0,
        {
          save: vi.fn().mockRejectedValue(new SceneConflictError()),
          backup: vi.fn().mockResolvedValue(undefined),
          notify: vi.fn(),
        },
        10000,
      ),
      older = scene([wall(1)]),
      newer = scene([wall(2)]);
    queue.schedule(older);
    queue.schedule(newer);
    queue.acknowledgeScene(older);
    expect(queue.dirty).toBe(true);
    await queue.flush();
    queue.acknowledgeScene(newer);
    expect(queue.dirty).toBe(false);
  });
});
