import { it, expect } from "vitest";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { betaSnapshot } from "./fixture";
import { CalculationEngine } from "../../src/calculation/engine";
import { evaluateIssues } from "../../src/issues/engine";
import { detectRooms } from "../../src/geometry/rooms";
import { polygonArea } from "../../src/geometry/primitives";
import { parseSnapshot } from "../../src/domain/snapshot";
import { createZip } from "../../src/features/export/zip";
import {
  decodeProject,
  PROJECT_JSON,
  type PortableProject,
} from "../../src/features/export/package";
import { importProject } from "../../src/infrastructure/import-repository";
import { ZamerDatabase } from "../../src/infrastructure/database";
import { projectSnapshot } from "../../src/infrastructure/cloud-repository";
const metrics: Record<string, number> = {};
function measure<T>(name: string, run: () => T): T {
  const start = performance.now();
  const result = run();
  metrics[name] = +(performance.now() - start).toFixed(2);
  return result;
}
function saveMetrics() {
  const path =
    process.env.BETA_METRICS_PATH ?? "artifacts/beta-node-metrics.json";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        runtime: process.version,
        platform: process.platform,
        dataset: {
          floors: 20,
          walls: 5000,
          rooms: 200,
          defects: 1000,
          photos: 2000,
        },
        synthetic: true,
        metricsMs: metrics,
      },
      null,
      2,
    ),
  );
  console.info("Beta measurements (ms)", JSON.stringify(metrics));
}
it("calculates 20 floors / 5000 walls / 200 precise rooms and keeps cache and source numbers", () => {
  const source = betaSnapshot();
  const before = JSON.stringify(source);
  measure("allFloorsCalculation", () => {
    for (const floor of source.floors) {
      const scene = {
        walls: source.walls.filter((w) => w.floorId === floor.id),
        rooms: source.rooms.filter((r) => r.floorId === floor.id),
        elements: [],
        dimensions: [],
        junctions: [],
      };
      const engine = new CalculationEngine();
      const result = engine.evaluate(scene, 2.7);
      expect(result.rooms).toHaveLength(10);
      for (const face of result.topology.candidates)
        expect(polygonArea(face.boundary)).toBeCloseTo(12.771, 9);
      expect(engine.evaluate(scene, 2.7)).toBe(result);
      expect(
        evaluateIssues({ scene, floorId: floor.id, height: 2.7 }).some(
          (i) => i.ruleId === "rule-failed",
        ),
      ).toBe(false);
    }
  });
  expect(JSON.stringify(source)).toBe(before);
  expect(
    source.walls.every(
      (w) => w.measuredLength === 4.257 || w.measuredLength === 3,
    ),
  ).toBe(true);
  saveMetrics();
}, 60000);
it("topology on a single floor with 5000 separated walls preserves 200 exact rooms", () => {
  const source = betaSnapshot();
  const floorId = source.floors[0].id;
  const walls = source.walls.map((w) => ({
    ...w,
    floorId,
    start: {
      x: w.start.x + source.floors.find((f) => f.id === w.floorId)!.order * 400,
      y: w.start.y,
    },
    end: {
      x: w.end.x + source.floors.find((f) => f.id === w.floorId)!.order * 400,
      y: w.end.y,
    },
  }));
  const topology = measure("singleFloor5000Topology", () => detectRooms(walls));
  expect(topology.candidates).toHaveLength(200);
  topology.candidates.forEach((face) =>
    expect(polygonArea(face.boundary)).toBeCloseTo(12.771, 9),
  );
  saveMetrics();
}, 60000);
it("restores a ZIP with 2000 unique synthetic originals, all geometry and defects after database reopen", async () => {
  const source = betaSnapshot();
  const now = source.project.createdAt;
  const png = readFileSync(new URL("../fixtures/photo.png", import.meta.url));
  const files = new Map<string, Uint8Array>();
  const originals: PortableProject["originals"] = [];
  const start = performance.now();
  for (let i = 0; i < 2000; i++) {
    const bytes = new Uint8Array(png.length + 4);
    bytes.set(png);
    new DataView(bytes.buffer).setUint32(png.length, i);
    const checksum = Buffer.from(
      await crypto.subtle.digest("SHA-256", bytes),
    ).toString("hex");
    const path = `05_Фотографии/Фото_${i}.png`;
    files.set(path, bytes);
    originals.push({
      path,
      checksum,
      size: bytes.length,
      mimeType: "image/png",
    });
    const photoId = crypto.randomUUID();
    source.photos.push({
      id: photoId,
      projectId: source.project.id,
      floorId: source.floors[i % 20].id,
      roomId: null,
      elementId: null,
      defectId: source.defects[i % 1000].id,
      storageKey: `${source.project.id}/${photoId}/${checksum}`,
      checksum,
      originalName: `Фото_${i}.png`,
      mimeType: "image/png",
      size: bytes.length,
      caption: "Синтетический fixture",
      createdAt: now,
      sourceModifiedAt: i,
      deletedAt: null,
    });
  }
  parseSnapshot(source);
  const manifest: PortableProject = {
    format: "zamer-project",
    packageVersion: 1,
    createdAt: now,
    source,
    originals,
    documents: [],
    prices: [],
    excludedIds: [],
    artifacts: [],
    warnings: [],
  };
  files.set(PROJECT_JSON, new TextEncoder().encode(JSON.stringify(manifest)));
  const zip = measure("zipCreate", () => createZip(files));
  const decodeStart = performance.now();
  const decoded = await decodeProject(zip, false);
  metrics.zipValidate = +(performance.now() - decodeStart).toFixed(2);
  const name = `beta-${crypto.randomUUID()}`;
  let db = new ZamerDatabase(name);
  try {
    const restoreStart = performance.now();
    const copy = await importProject(db, decoded, "Beta восстановление");
    metrics.restore = +(performance.now() - restoreStart).toFixed(2);
    db.close();
    db = new ZamerDatabase(name);
    const recovered = await projectSnapshot(db, copy.project.id);
    expect(recovered.floors).toHaveLength(20);
    expect(recovered.walls).toHaveLength(5000);
    expect(recovered.rooms).toHaveLength(200);
    expect(recovered.defects).toHaveLength(1000);
    expect(recovered.photos).toHaveLength(2000);
    expect(recovered.walls.map((w) => w.measuredLength).sort()).toEqual(
      source.walls.map((w) => w.measuredLength).sort(),
    );
    expect(await db.photoFiles.count()).toBe(2000);
    expect(await db.outbox.count()).toBe(0);
    for (const photo of recovered.photos) {
      expect(recovered.defects.some((d) => d.id === photo.defectId)).toBe(true);
      const file = await db.photoFiles.get(photo.checksum);
      expect(file).toBeDefined();
      const original = originals.find((o) => o.checksum === photo.checksum)!;
      expect(
        Buffer.compare(
          Buffer.from(await file!.original.arrayBuffer()),
          Buffer.from(files.get(original.path)!),
        ),
      ).toBe(0);
    }
  } finally {
    await db.delete();
  }
  metrics.fullSyntheticRecovery = +(performance.now() - start).toFixed(2);
  saveMetrics();
}, 60000);
