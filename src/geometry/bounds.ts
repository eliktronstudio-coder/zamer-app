import type { Point } from "../domain/model";
import type { Segment } from "./segments";
import { GEOMETRY_EPSILON } from "./primitives";
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
export function pointBounds(
  points: readonly Point[],
  margin = 0,
): Bounds | null {
  if (!points.length) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return {
    minX: minX - margin,
    minY: minY - margin,
    maxX: maxX + margin,
    maxY: maxY + margin,
  };
}
export function boundsOverlap(a: Bounds, b: Bounds, epsilon = 0): boolean {
  return (
    a.maxX + epsilon >= b.minX &&
    b.maxX + epsilon >= a.minX &&
    a.maxY + epsilon >= b.minY &&
    b.maxY + epsilon >= a.minY
  );
}
interface Node {
  bounds: Bounds;
  maxIndex: number;
  index?: number;
  left?: Node;
  right?: Node;
}
/** Conservative broad phase. Returns original i,j order; exact intersections remain authoritative. */
export function* overlappingSegmentPairs(
  segments: readonly Segment[],
): Generator<[number, number]> {
  const boxes = segments.map((s) => pointBounds([s.start, s.end])!);
  const order = boxes
    .map((_, i) => i)
    .sort((a, b) => boxes[a].minX - boxes[b].minX || a - b);
  function tree(start: number, end: number): Node {
    if (end - start === 1) {
      const index = order[start];
      return { bounds: boxes[index], maxIndex: index, index };
    }
    const mid = (start + end) >>> 1,
      left = tree(start, mid),
      right = tree(mid, end);
    return {
      bounds: {
        minX: Math.min(left.bounds.minX, right.bounds.minX),
        minY: Math.min(left.bounds.minY, right.bounds.minY),
        maxX: Math.max(left.bounds.maxX, right.bounds.maxX),
        maxY: Math.max(left.bounds.maxY, right.bounds.maxY),
      },
      maxIndex: Math.max(left.maxIndex, right.maxIndex),
      left,
      right,
    };
  }
  if (!segments.length) return;
  const root = tree(0, segments.length);
  for (let i = 0; i < segments.length; i++) {
    const found: number[] = [],
      stack = [root];
    while (stack.length) {
      const n = stack.pop()!;
      if (
        n.maxIndex <= i ||
        !boundsOverlap(boxes[i], n.bounds, GEOMETRY_EPSILON)
      )
        continue;
      if (n.index !== undefined) found.push(n.index);
      else {
        stack.push(n.right!, n.left!);
      }
    }
    for (const j of found.sort((a, b) => a - b)) yield [i, j];
  }
}
