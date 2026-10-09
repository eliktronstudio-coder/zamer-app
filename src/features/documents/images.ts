import type { GeometryScene } from "../../geometry/constraints";
import type { Floor, Defect } from "../../domain/model";
import { elementFootprint } from "../../calculation/quantities";
export function planImage(
  scene: GeometryScene,
  floor: Floor,
  defects: Defect[],
) {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 700;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas недоступен");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 1200, 700);
  const points = [
    ...scene.walls.flatMap((w) => [w.start, w.end]),
    ...(scene.rooms ?? []).flatMap((r) => r.boundary),
    ...(scene.elements ?? []).flatMap((e) =>
      e.kind === "levelChange"
        ? e.boundary
        : e.kind === "opening"
          ? []
          : elementFootprint(e).flatMap((poly) =>
              poly.flatMap((ring) => ring.map(([x, y]) => ({ x, y }))),
            ),
    ),
    ...defects.flatMap((d) => (d.position ? [d.position] : [])),
  ];
  const minX = points.length ? Math.min(...points.map((p) => p.x)) : 0,
    minY = points.length ? Math.min(...points.map((p) => p.y)) : 0;
  const width = Math.max(
      1,
      (points.length ? Math.max(...points.map((p) => p.x)) : 1) - minX,
    ),
    height = Math.max(
      1,
      (points.length ? Math.max(...points.map((p) => p.y)) : 1) - minY,
    );
  const scale = Math.min(1080 / width, 560 / height),
    x = (n: number) => 60 + (n - minX) * scale,
    y = (n: number) => 70 + (n - minY) * scale;
  ctx.font = "24px ZamerReport, sans-serif";
  ctx.fillStyle = "#17665b";
  ctx.fillText(`${floor.name} · план в метрах`, 40, 40);
  for (const r of scene.rooms ?? []) {
    if (!r.boundary.length) continue;
    ctx.fillStyle = "#17665b";
    ctx.font = "18px ZamerReport, sans-serif";
    ctx.fillText(
      r.name || "Без названия",
      x(r.boundary.reduce((s, p) => s + p.x, 0) / r.boundary.length),
      y(r.boundary.reduce((s, p) => s + p.y, 0) / r.boundary.length),
    );
  }
  for (const w of scene.walls) {
    ctx.strokeStyle = "#344b56";
    ctx.lineWidth = Math.max(2, w.thickness * scale);
    ctx.beginPath();
    ctx.moveTo(x(w.start.x), y(w.start.y));
    ctx.lineTo(x(w.end.x), y(w.end.y));
    ctx.stroke();
  }
  for (const e of scene.elements ?? []) {
    if (e.kind === "opening") {
      const w = scene.walls.find((w) => w.id === e.wallId);
      if (!w) continue;
      const length = Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
      if (!length) continue;
      ctx.strokeStyle = e.type === "window" ? "#2587af" : "#bb874c";
      ctx.lineWidth = Math.max(3, w.thickness * scale + 2);
      ctx.beginPath();
      ctx.moveTo(
        x(w.start.x + ((w.end.x - w.start.x) * e.offset) / length),
        y(w.start.y + ((w.end.y - w.start.y) * e.offset) / length),
      );
      ctx.lineTo(
        x(w.start.x + ((w.end.x - w.start.x) * (e.offset + e.width)) / length),
        y(w.start.y + ((w.end.y - w.start.y) * (e.offset + e.width)) / length),
      );
      ctx.stroke();
    } else {
      const polygons =
        e.kind === "levelChange"
          ? [[e.boundary.map((p) => [p.x, p.y])]]
          : elementFootprint(e);
      ctx.strokeStyle = "#587958";
      ctx.lineWidth = 2;
      for (const poly of polygons)
        for (const ring of poly) {
          ctx.beginPath();
          ring.forEach(([a, b], i) =>
            i ? ctx.lineTo(x(a), y(b)) : ctx.moveTo(x(a), y(b)),
          );
          if (ring.length > 2) ctx.closePath();
          ctx.stroke();
        }
    }
  }
  // Draw dimension labels last so adjacent thick walls/openings cannot cover them.
  ctx.font = "16px ZamerReport, sans-serif";
  for (const w of scene.walls) {
    const length =
      w.measuredLength ?? Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
    const text = `${length.toLocaleString("ru-RU", { maximumFractionDigits: 4 })} м`;
    const textWidth = ctx.measureText(text).width;
    const labelX = Math.max(
      4,
      Math.min(1196 - textWidth, x((w.start.x + w.end.x) / 2) + 8),
    );
    const labelY = Math.max(
      62,
      Math.min(644, y((w.start.y + w.end.y) / 2) - 12),
    );
    ctx.fillStyle = "white";
    ctx.fillRect(labelX - 3, labelY - 17, textWidth + 6, 22);
    ctx.fillStyle = "#344b56";
    ctx.fillText(text, labelX, labelY);
  }
  for (const d of defects)
    if (d.position) {
      ctx.fillStyle = "#c33737";
      ctx.beginPath();
      ctx.arc(x(d.position.x), y(d.position.y), 7, 0, Math.PI * 2);
      ctx.fill();
    }
  ctx.fillStyle = "#344b56";
  ctx.font = "16px ZamerReport, sans-serif";
  ctx.fillText(
    "Обзорный план. Размеры и UUID источников — в ведомости; масштаб изображения не фиксирован.",
    40,
    675,
  );
  return canvas.toDataURL("image/png");
}
export async function viewImage(
  scene: GeometryScene,
  floor: Floor,
): Promise<string | null> {
  const THREE = await import("three"),
    { buildFloorModel, disposeModel } = await import("../three/model");
  let renderer: InstanceType<typeof THREE.WebGLRenderer> | undefined;
  const model = buildFloorModel(scene, floor);
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(1200, 700);
    renderer.setPixelRatio(1);
    const world = new THREE.Scene();
    world.background = new THREE.Color("#f5f7f7");
    world.add(model.group);
    world.add(new THREE.HemisphereLight(0xffffff, 0x778899, 2.5));
    const light = new THREE.DirectionalLight(0xffffff, 2);
    light.position.set(5, 12, 7);
    world.add(light);
    const bounds = new THREE.Box3().setFromObject(model.group),
      center = bounds.isEmpty()
        ? new THREE.Vector3()
        : bounds.getCenter(new THREE.Vector3()),
      size = bounds.isEmpty()
        ? new THREE.Vector3(2, 2, 2)
        : bounds.getSize(new THREE.Vector3());
    const radius = Math.max(2, size.length());
    const camera = new THREE.PerspectiveCamera(
      45,
      1200 / 700,
      0.001,
      radius * 100,
    );
    camera.position
      .copy(center)
      .add(new THREE.Vector3(radius * 1.2, radius * 0.9, radius * 1.2));
    camera.lookAt(center);
    renderer.render(world, camera);
    return renderer.domElement.toDataURL("image/png");
  } catch {
    return null;
  } finally {
    disposeModel(model.group);
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
}
