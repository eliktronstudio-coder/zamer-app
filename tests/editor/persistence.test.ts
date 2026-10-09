import Dexie from "dexie";
import { afterEach, describe, it, expect } from "vitest";
import {
  ZamerDatabase,
  ProjectRepository,
} from "../../src/infrastructure/database";
import {
  SceneRepository,
  SceneConflictError,
} from "../../src/infrastructure/scene-storage";
import { parseSnapshot, serializeSnapshot } from "../../src/domain/snapshot";
import { createProject } from "../../src/domain/projects";
import { dimension, junction, scene, uuid, wall } from "../geometry/fixtures";
const databases: ZamerDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete();
});
async function setup() {
  const db = new ZamerDatabase(`editor-${crypto.randomUUID()}`);
  databases.push(db);
  const projects = new ProjectRepository(db),
    data = await projects.create("Дом", "Первый");
  return { db, projects, ...data, repo: new SceneRepository(db) };
}
describe("scene persistence and migrations", () => {
  it("migrates a real v1 IndexedDB preserving projects, floors, walls and exact input", async () => {
    const name = `legacy-${crypto.randomUUID()}`,
      legacy = new Dexie(name);
    legacy.version(1).stores({
      projects: "id,status,updatedAt",
      floors: "id,projectId,[projectId+order]",
      walls: "id,floorId",
    });
    const { project, floor } = createProject("Старый", "Первый"),
      w = wall(1, { x: 0, y: 0 }, { x: 4.257, y: 0 }, { floorId: floor.id });
    await legacy.table("projects").add(project);
    await legacy.table("floors").add(floor);
    await legacy.table("walls").add(w);
    legacy.close();
    const db = new ZamerDatabase(name);
    databases.push(db);
    const loaded = await new SceneRepository(db).load(floor.id);
    expect(loaded.scene.walls).toEqual([w]);
    expect(loaded.scene.dimensions).toEqual([]);
    expect(loaded.revision).toBe(0);
    expect(await db.projects.get(project.id)).toEqual(project);
  });
  it("roundtrips all supported geometry and references after reopening", async () => {
    const { db, repo, floor } = await setup();
    const a = wall(1, undefined, undefined, { floorId: floor.id }),
      b = wall(2, a.end, { x: 4.25, y: 3 }, { floorId: floor.id });
    const expected = scene([a, b], [dimension(10, a)], [junction(20, a, b)]);
    expect(await repo.save(floor.id, expected, 0)).toBe(1);
    db.close();
    await db.open();
    expect(await repo.load(floor.id)).toEqual({ scene: expected, revision: 1 });
  });
  it("concurrent writers cannot overwrite the same scene revision", async () => {
    const { repo, floor } = await setup();
    const a = scene([wall(1, undefined, undefined, { floorId: floor.id })]),
      b = scene([wall(2, undefined, undefined, { floorId: floor.id })]);
    const outcomes = await Promise.allSettled([
      repo.save(floor.id, a, 0),
      repo.save(floor.id, b, 0),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = outcomes.find((r) => r.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason).toBeInstanceOf(
      SceneConflictError,
    );
    expect((await repo.load(floor.id)).scene).toEqual(a);
  });
  it("rejects another floor ID and preserves the existing scene", async () => {
    const { repo, floor } = await setup();
    const initial = scene([
      wall(1, undefined, undefined, { floorId: floor.id }),
    ]);
    await repo.save(floor.id, initial, 0);
    await expect(repo.save(floor.id, scene([wall(2)]), 1)).rejects.toThrow();
    expect((await repo.load(floor.id)).scene).toEqual(initial);
  });
  it("rejects cross-floor global key collisions atomically", async () => {
    const { repo, floor, projects, project } = await setup();
    const next = await projects.addFloor(project.id, "Второй"),
      w = wall(1, undefined, undefined, { floorId: floor.id });
    await repo.save(floor.id, scene([w]), 0);
    await expect(
      repo.save(next.id, scene([{ ...w, floorId: next.id }]), 0),
    ).rejects.toThrow();
    expect((await repo.load(floor.id)).scene.walls).toEqual([w]);
    expect((await repo.load(next.id)).revision).toBe(0);
  });
  it("recovers a conflict to a separate floor with remapped UUIDs, preserving the other version", async () => {
    const { repo, floor } = await setup(),
      a = wall(1, undefined, undefined, { floorId: floor.id }),
      b = wall(2, a.end, { x: 4.25, y: 3 }, { floorId: floor.id });
    const original = scene([a]);
    await repo.save(floor.id, original, 0);
    const draft = scene([a, b], [dimension(10, a)], [junction(20, a, b)]);
    await repo.backup(uuid(50), floor.id, draft);
    const recovered = await repo.recover(uuid(50));
    const restored = (await repo.load(recovered.id)).scene;
    expect(restored.walls).toHaveLength(2);
    // IndexedDB enumerates primary UUID keys, not creation order.
    const restoredA = restored.walls.find(
      (w) => w.start.x === a.start.x && w.start.y === a.start.y,
    )!;
    const restoredB = restored.walls.find(
      (w) => w.end.x === b.end.x && w.end.y === b.end.y,
    )!;
    expect(restoredA.id).not.toBe(a.id);
    expect(restoredB.id).not.toBe(b.id);
    expect(restored.dimensions[0].from.elementId).toBe(restoredA.id);
    expect(restored.junctions[0].endpoints[1].elementId).toBe(restoredB.id);
    expect((await repo.load(floor.id)).scene).toEqual(original);
    expect(await repo.drafts(floor.id)).toEqual([]);
  });
  it("rolls back geometry, revision, project timestamp and recovery deletion on transaction abort", async () => {
    const { db, repo, floor, project } = await setup();
    const original = scene([
      wall(1, undefined, undefined, { floorId: floor.id }),
    ]);
    const changed = scene([
      wall(2, undefined, undefined, { floorId: floor.id }),
    ]);
    await repo.save(floor.id, original, 0);
    await repo.backup(uuid(50), floor.id, changed);
    const before = await db.projects.get(project.id);
    await expect(
      db.transaction("rw", db.tables, async () => {
        await repo.save(floor.id, changed, 1, uuid(50));
        throw new Error("Simulated interrupted transaction");
      }),
    ).rejects.toThrow("Simulated interrupted transaction");
    expect(await repo.load(floor.id)).toEqual({ scene: original, revision: 1 });
    expect(await db.projects.get(project.id)).toEqual(before);
    expect(await repo.drafts(floor.id)).toHaveLength(1);
  });
  it("successful retry removes its recovery copy in the same transaction", async () => {
    const { repo, floor } = await setup(),
      s = scene([wall(1, undefined, undefined, { floorId: floor.id })]);
    await repo.backup(uuid(50), floor.id, s);
    await repo.save(floor.id, s, 0, uuid(50));
    expect(await repo.drafts(floor.id)).toEqual([]);
  });
});
describe("project.json version migration", () => {
  it("migrates v1 without changing original IDs or exact numbers", () => {
    const { project, floor } = createProject("Дом", "Этаж"),
      w = wall(1, { x: 0, y: 0 }, { x: 4.257, y: 0 }, { floorId: floor.id });
    const old = {
      schemaVersion: 1,
      geometrySchemaVersion: 1,
      exportSchemaVersion: 1,
      project,
      floors: [floor],
      walls: [w],
    };
    const parsed = parseSnapshot(old);
    expect(parsed.schemaVersion).toBe(5);
    expect(parsed.walls[0]).toEqual(w);
    expect(parsed.junctions).toEqual([]);
    expect(old.schemaVersion).toBe(1);
  });
  it("roundtrips v2 links and dimensions and rejects lost references", () => {
    const { project, floor } = createProject("Дом", "Этаж"),
      w = wall(1, undefined, undefined, { floorId: floor.id });
    const parsed = parseSnapshot({
      schemaVersion: 2,
      geometrySchemaVersion: 2,
      exportSchemaVersion: 2,
      project,
      floors: [floor],
      walls: [w],
      dimensions: [dimension(10, w)],
      junctions: [],
    });
    expect(parseSnapshot(JSON.parse(serializeSnapshot(parsed)))).toEqual(
      parsed,
    );
    expect(() => parseSnapshot({ ...parsed, walls: [] })).toThrow();
  });
});

describe("phase 4 persisted construction elements", () => {
  it("upgrades an actual v2 database and its pending recovery drafts", async () => {
    const name = `legacy-v2-${crypto.randomUUID()}`,
      legacy = new Dexie(name);
    legacy.version(2).stores({
      projects: "id,status,updatedAt",
      floors: "id,projectId,[projectId+order]",
      walls: "id,floorId",
      junctions: "id,floorId",
      dimensions: "id,floorId",
      sceneRevisions: "floorId",
      recoveryDrafts: "id,floorId,updatedAt",
    });
    const { project, floor } = createProject("Старый", "Первый"),
      w = wall(1, undefined, undefined, { floorId: floor.id });
    await legacy.table("projects").add(project);
    await legacy.table("floors").add(floor);
    await legacy.table("walls").add(w);
    await legacy
      .table("sceneRevisions")
      .add({ floorId: floor.id, revision: 7 });
    await legacy.table("recoveryDrafts").add({
      id: uuid(50),
      floorId: floor.id,
      updatedAt: new Date().toISOString(),
      scene: { walls: [w], dimensions: [], junctions: [] },
    });
    legacy.close();
    const db = new ZamerDatabase(name);
    databases.push(db);
    const repo = new SceneRepository(db);
    expect(await repo.load(floor.id)).toEqual({
      scene: {
        walls: [w],
        dimensions: [],
        junctions: [],
        elements: [],
        rooms: [],
      },
      revision: 7,
    });
    expect((await repo.drafts(floor.id))[0].scene.elements).toEqual([]);
  });
  it("persists every construction kind, restores linked openings to a new floor, and rejects cross-floor keys", async () => {
    const { db, repo, floor, project, projects } = await setup(),
      w = wall(1, undefined, undefined, { floorId: floor.id });
    const { defaultElement } =
      await import("../../src/editor/element-commands");
    const elements = ["column", "beam", "stair", "ramp", "levelChange"].map(
      (tool) =>
        defaultElement(
          tool as "column" | "beam" | "stair" | "ramp" | "levelChange",
          floor.id,
          2.7,
        ),
    );
    const opening = defaultElement("window", floor.id, 2.7);
    if (opening.kind !== "opening") throw new Error();
    elements.push({ ...opening, wallId: w.id, offset: 0.257 });
    const s = { ...scene([w]), elements };
    await repo.save(floor.id, s, 0);
    db.close();
    await db.open();
    const loaded = (await repo.load(floor.id)).scene;
    expect(loaded.elements).toHaveLength(6);
    expect(loaded.elements).toEqual(expect.arrayContaining(elements));
    await repo.backup(uuid(50), floor.id, s);
    const copied = await repo.recover(uuid(50)),
      restored = (await repo.load(copied.id)).scene;
    const restoredOpening = restored.elements?.find(
      (e) => e.kind === "opening",
    );
    expect(restoredOpening?.kind === "opening" && restoredOpening.wallId).toBe(
      restored.walls[0].id,
    );
    expect(restored.elements?.every((e) => e.floorId === copied.id)).toBe(true);
    expect((await repo.load(floor.id)).scene).toEqual(loaded);
    const next = await projects.addFloor(project.id, "Второй");
    await expect(
      repo.save(
        next.id,
        { ...scene([]), elements: [{ ...elements[0], floorId: next.id }] },
        0,
      ),
    ).rejects.toThrow("Идентификатор");
    expect((await repo.load(next.id)).revision).toBe(0);
  });
  it("preserves all entity tables and recovery copies on interrupted saves", async () => {
    const { db, repo, floor } = await setup();
    const { defaultElement } =
      await import("../../src/editor/element-commands");
    const a = {
        ...scene([]),
        elements: [defaultElement("column", floor.id, 2.7)],
      },
      b = { ...scene([]), elements: [defaultElement("ramp", floor.id, 2.7)] };
    await repo.save(floor.id, a, 0);
    await repo.backup(uuid(50), floor.id, b);
    await expect(
      db.transaction("rw", db.tables, async () => {
        await repo.save(floor.id, b, 1, uuid(50));
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await repo.load(floor.id)).toEqual({ scene: a, revision: 1 });
    expect(await repo.drafts(floor.id)).toHaveLength(1);
  });
  it("migrates v2 snapshots and roundtrips v3 elements and their wall references", async () => {
    const { project, floor } = createProject("Дом", "Первый"),
      w = wall(1, undefined, undefined, { floorId: floor.id });
    const v2 = {
      schemaVersion: 2,
      geometrySchemaVersion: 2,
      exportSchemaVersion: 2,
      project,
      floors: [floor],
      walls: [w],
      dimensions: [],
      junctions: [],
    };
    const migrated = parseSnapshot(v2);
    expect(migrated.schemaVersion).toBe(5);
    expect(migrated.elements).toEqual([]);
    const { defaultElement } =
      await import("../../src/editor/element-commands");
    const window = defaultElement("window", floor.id, 2.7);
    if (window.kind !== "opening") throw new Error();
    const v3 = {
      ...migrated,
      elements: [
        { ...window, wallId: w.id, offset: 0.257 },
        defaultElement("column", floor.id, 2.7),
      ],
    };
    expect(parseSnapshot(JSON.parse(serializeSnapshot(v3)))).toEqual(v3);
    expect(() => parseSnapshot({ ...v3, walls: [] })).toThrow("связь");
  });
});

describe("room storage v4", () => {
  it("saves, reopens and restores a room with exact quantities and wall memberships", async () => {
    const { db, repo, floor } = await setup();
    const { detectRooms } = await import("../../src/geometry/rooms");
    const { createRoom, reconcileRooms } =
      await import("../../src/calculation/engine");
    const pts = [
      { x: 0, y: 0 },
      { x: 4.257, y: 0 },
      { x: 4.257, y: 3 },
      { x: 0, y: 3 },
    ];
    const walls = pts.map((p, i) =>
      wall(i + 1, p, pts[(i + 1) % 4], { floorId: floor.id }),
    );
    const room = createRoom(detectRooms(walls).candidates[0], "Спальня", null);
    const expected = reconcileRooms({ ...scene(walls), rooms: [room] }, 2.7);
    await repo.save(floor.id, expected, 0);
    db.close();
    await db.open();
    const loaded = await repo.load(floor.id);
    expect(loaded.scene).toEqual(expected);
    await repo.backup(uuid(77), floor.id, expected);
    const recovered = await repo.recover(uuid(77));
    const copy = (await repo.load(recovered.id)).scene;
    expect(copy.rooms![0]).toMatchObject({
      name: room.name,
      geometricallyClosed: true,
      floorId: recovered.id,
    });
    expect(copy.rooms![0].id).not.toBe(room.id);
    expect(copy.walls.every((w) => w.roomIds.includes(copy.rooms![0].id))).toBe(
      true,
    );
    expect(copy.rooms![0].wallIds.sort()).toEqual(
      copy.walls.map((w) => w.id).sort(),
    );
    expect((await repo.load(floor.id)).scene).toEqual(expected);
    const snapshot = {
      schemaVersion: 4 as const,
      geometrySchemaVersion: 4 as const,
      exportSchemaVersion: 4 as const,
      project: (await db.projects.get(floor.projectId))!,
      floors: [floor],
      ...expected,
      rooms: expected.rooms!,
      elements: expected.elements!,
    };
    expect(
      parseSnapshot(JSON.parse(serializeSnapshot(parseSnapshot(snapshot)))),
    ).toEqual(parseSnapshot(snapshot));
    const { rooms: omittedRooms, ...legacySnapshot } = snapshot;
    expect(omittedRooms).toHaveLength(1);
    const migrated = parseSnapshot({
      ...legacySnapshot,
      schemaVersion: 3,
      geometrySchemaVersion: 3,
      exportSchemaVersion: 3,
      walls: walls.map((w) => ({ ...w, roomIds: [] })),
    });
    expect(migrated.rooms).toEqual([]);
    const broken = {
      ...expected,
      walls: expected.walls.slice(1),
      rooms: [
        { ...room, geometricallyClosed: false, status: "issues" as const },
      ],
    };
    await repo.save(floor.id, broken, 1);
    expect((await repo.load(floor.id)).scene.rooms![0].id).toBe(room.id);
  });
  it("migrates a real v3 database and pending recovery without inventing rooms", async () => {
    const name = `v3-${crypto.randomUUID()}`,
      legacy = new Dexie(name);
    legacy.version(3).stores({
      projects: "id,status,updatedAt",
      floors: "id,projectId,[projectId+order]",
      walls: "id,floorId",
      junctions: "id,floorId",
      dimensions: "id,floorId",
      sceneRevisions: "floorId",
      recoveryDrafts: "id,floorId,updatedAt",
      elements: "id,floorId,kind,wallId",
    });
    const { project, floor } = createProject("v3", "Первый");
    await legacy.table("projects").add(project);
    await legacy.table("floors").add(floor);
    await legacy.table("recoveryDrafts").add({
      id: uuid(88),
      floorId: floor.id,
      updatedAt: new Date().toISOString(),
      scene: { walls: [], junctions: [], dimensions: [], elements: [] },
    });
    legacy.close();
    const db = new ZamerDatabase(name);
    databases.push(db);
    expect((await new SceneRepository(db).load(floor.id)).scene.rooms).toEqual(
      [],
    );
    expect((await db.recoveryDrafts.get(uuid(88)))!.scene.rooms).toEqual([]);
  });
});
