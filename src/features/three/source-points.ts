import type { Point } from "../../domain/model";
import type { GeometryScene } from "../../geometry/constraints";
export function sourcePoints(scene: GeometryScene, id: string): Point[] {
  const w = scene.walls.find((w) => w.id === id);
  if (w) return [w.start, w.end];
  const e = scene.elements?.find((e) => e.id === id);
  if (e) {
    if (e.kind === "opening") {
      const wall = scene.walls.find((w) => w.id === e.wallId);
      return wall ? [wall.start, wall.end] : [];
    }
    if (e.kind === "beam") return [e.start, e.end];
    if (e.kind === "levelChange") return e.boundary;
    return [e.position];
  }
  return scene.rooms?.find((r) => r.id === id)?.boundary ?? [];
}
