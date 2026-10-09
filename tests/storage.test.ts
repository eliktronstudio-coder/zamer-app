import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ZamerDatabase,
  ProjectRepository,
} from "../src/infrastructure/database";
let db: ZamerDatabase;
let repo: ProjectRepository;
beforeEach(() => {
  db = new ZamerDatabase(`test-${crypto.randomUUID()}`);
  repo = new ProjectRepository(db);
});
afterEach(async () => {
  await db.delete();
});
describe("IndexedDB persistence", () => {
  it("restores project and floor after closing the database", async () => {
    const { project, floor } = await repo.create("Дом", "Первый");
    db.close();
    await db.open();
    expect(await repo.get(project.id)).toEqual(project);
    expect(await repo.floors(project.id)).toEqual([floor]);
  });
  it("invalid floor leaves no partial project", async () => {
    await expect(repo.create("Дом", " ")).rejects.toThrow();
    expect(await repo.list()).toHaveLength(0);
  });
  it("transaction rollback preserves consistency", async () => {
    await expect(
      db.transaction("rw", db.projects, db.floors, async () => {
        const { project } = await repo.create("Дом", "Этаж");
        expect(await db.projects.get(project.id)).toBeDefined();
        throw new Error("simulated storage failure");
      }),
    ).rejects.toThrow();
    expect(await db.projects.count()).toBe(0);
    expect(await db.floors.count()).toBe(0);
  });
  it("archives, renames, trashes and restores without losing floors", async () => {
    const { project, floor } = await repo.create("Дом", "Этаж");
    await repo.rename(project.id, "Офис");
    await repo.status(project.id, "archived");
    expect((await repo.get(project.id))?.status).toBe("archived");
    await repo.status(project.id, "trashed");
    await repo.status(project.id, "active");
    expect((await repo.get(project.id))?.name).toBe("Офис");
    expect(await repo.floors(project.id)).toEqual([floor]);
  });
  it("serializes concurrent floor creation with distinct ordering", async () => {
    const { project } = await repo.create("Дом", "Первый");
    await Promise.all([
      repo.addFloor(project.id, "Второй"),
      repo.addFloor(project.id, "Третий"),
    ]);
    expect((await repo.floors(project.id)).map((f) => f.order)).toEqual([
      0, 1, 2,
    ]);
  });
  it("rejects editing archived projects", async () => {
    const { project } = await repo.create("Дом", "Первый");
    await repo.status(project.id, "archived");
    await expect(repo.addFloor(project.id, "Второй")).rejects.toThrow();
  });
});
