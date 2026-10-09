import type { Point } from "../domain/model";
export interface Viewport {
  x: number;
  y: number;
  scale: number;
}
export const screenToWorld = (point: Point, v: Viewport): Point => ({
  x: (point.x - v.x) / v.scale,
  y: (point.y - v.y) / v.scale,
});
export const worldToScreen = (point: Point, v: Viewport): Point => ({
  x: point.x * v.scale + v.x,
  y: point.y * v.scale + v.y,
});
export function zoomAt(v: Viewport, screen: Point, scale: number): Viewport {
  const next = Math.max(15, Math.min(600, scale)),
    world = screenToWorld(screen, v);
  return {
    scale: next,
    x: screen.x - world.x * next,
    y: screen.y - world.y * next,
  };
}
