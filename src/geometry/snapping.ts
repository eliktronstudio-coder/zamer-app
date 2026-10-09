import type { Point, PointReference, Wall } from "../domain/model";
import { resolveReference } from "./dimensions";
import { distance, GEOMETRY_EPSILON } from "./primitives";
import {
  intersectSegments,
  nearestOnSegment,
  projectToLine,
  type Segment,
} from "./segments";
import { assertPoint, assertPositive, interpolate } from "./vector";
import { wallEdges, orthogonalTarget } from "./walls";

export type BuiltInSnapKind =
  | "start"
  | "end"
  | "center"
  | "edge"
  | "far-edge"
  | "axis"
  | "nearest"
  | "intersection"
  | "linked";
export interface SnapFeature {
  kind: string;
  point: Point;
  elementIds: string[];
  guide?: Segment;
}
export interface SnapCandidate extends SnapFeature {
  distance: number;
}
export interface SnapContext {
  pointer: Point;
  walls: readonly Wall[];
  floorId: string;
  tolerance: number;
  linkedReferences: readonly PointReference[];
}
export interface SnapProvider {
  kind: string;
  priority: number;
  candidates: (context: SnapContext) => readonly SnapFeature[];
}
export interface SnapOptions {
  pointer: Point;
  walls: readonly Wall[];
  floorId: string;
  pixelsPerMeter: number;
  tolerancePixels: number;
  enabledKinds?: readonly string[];
  linkedReferences?: readonly PointReference[];
  orthogonalFrom?: Point;
  providers?: readonly SnapProvider[];
}
export interface SnapResult {
  point: Point;
  candidate: SnapCandidate | null;
  candidates: readonly SnapCandidate[];
}
const endpointProvider = (anchor: "start" | "end"): SnapProvider => ({
  kind: anchor,
  priority: 0,
  candidates: ({ walls }) =>
    walls.map((w) => ({
      kind: anchor,
      point: { ...w[anchor] },
      elementIds: [w.id],
    })),
});
const edgesProvider = (far: boolean): SnapProvider => ({
  kind: far ? "far-edge" : "edge",
  priority: 4,
  candidates: ({ walls, pointer }) =>
    walls
      .filter((w) => distance(w.start, w.end) > 0)
      .map((w) => {
        const edges = wallEdges(w),
          left = nearestOnSegment(pointer, edges.left),
          right = nearestOnSegment(pointer, edges.right);
        const chooseLeft = far
          ? left.distance >= right.distance
          : left.distance <= right.distance;
        return {
          kind: far ? "far-edge" : "edge",
          point: chooseLeft ? left.point : right.point,
          elementIds: [w.id],
          guide: chooseLeft ? edges.left : edges.right,
        };
      }),
});
const intersectionProvider: SnapProvider = {
  kind: "intersection",
  priority: 1,
  candidates: ({ walls, pointer, tolerance }) => {
    // Intersections near the cursor must belong to segments within the snap radius.
    // Avoid the all-scene O(n²) scan; the editor will additionally supply visible walls.
    const nearby = walls.filter(
      (w) => nearestOnSegment(pointer, w).distance <= tolerance,
    );
    const features: SnapFeature[] = [];
    for (let i = 0; i < nearby.length; i++)
      for (let j = i + 1; j < nearby.length; j++) {
        const a = nearby[i],
          b = nearby[j],
          intersection = intersectSegments(a, b);
        if (intersection.kind === "point")
          features.push({
            kind: "intersection",
            point: intersection.point,
            elementIds: [a.id, b.id].sort(),
          });
        // A collinear overlap is an interval, not an invented intersection point.
      }
    return features;
  },
};
export const BUILT_IN_SNAP_PROVIDERS: readonly SnapProvider[] = Object.freeze([
  endpointProvider("start"),
  endpointProvider("end"),
  intersectionProvider,
  {
    kind: "linked",
    priority: 0,
    candidates: ({ walls, floorId, linkedReferences }) =>
      linkedReferences.flatMap((reference) => {
        const resolved = resolveReference(reference, walls, floorId);
        return resolved.ok
          ? [
              {
                kind: "linked",
                point: resolved.point,
                elementIds: [reference.elementId],
              },
            ]
          : [];
      }),
  },
  {
    kind: "center",
    priority: 2,
    candidates: ({ walls }) =>
      walls.map((w) => ({
        kind: "center",
        point: interpolate(w.start, w.end, 0.5),
        elementIds: [w.id],
      })),
  },
  edgesProvider(false),
  edgesProvider(true),
  {
    kind: "nearest",
    priority: 5,
    candidates: ({ walls, pointer }) =>
      walls.map((w) => ({
        kind: "nearest",
        point: nearestOnSegment(pointer, w).point,
        elementIds: [w.id],
      })),
  },
  {
    kind: "axis",
    priority: 6,
    candidates: ({ walls, pointer }) =>
      walls
        .filter((w) => distance(w.start, w.end) > 0)
        .map((w) => ({
          kind: "axis",
          point: projectToLine(pointer, w).point,
          elementIds: [w.id],
          guide: { start: { ...w.start }, end: { ...w.end } },
        })),
  },
]);
export function snapPoint(options: SnapOptions): SnapResult {
  assertPoint(options.pointer);
  assertPositive(options.pixelsPerMeter, "Масштаб");
  assertPositive(options.tolerancePixels, "Радиус привязки");
  if (options.orthogonalFrom) assertPoint(options.orthogonalFrom);
  const providers = options.providers ?? BUILT_IN_SNAP_PROVIDERS;
  if (new Set(providers.map((p) => p.kind)).size !== providers.length)
    throw new Error("Типы привязок должны быть уникальны");
  if (providers.some((p) => !Number.isFinite(p.priority)))
    throw new RangeError("Приоритет привязки должен быть конечным");
  const tolerance = options.tolerancePixels / options.pixelsPerMeter;
  assertPositive(tolerance, "Радиус привязки в метрах");
  const enabled = new Set(
    options.enabledKinds ?? [
      "start",
      "end",
      "center",
      "intersection",
      "nearest",
      "linked",
    ],
  );
  const context: SnapContext = {
    pointer: options.pointer,
    walls: options.walls
      .filter((w) => w.floorId === options.floorId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    floorId: options.floorId,
    tolerance,
    linkedReferences: options.linkedReferences ?? [],
  };
  const orthogonalPoint = options.orthogonalFrom
    ? orthogonalTarget(options.orthogonalFrom, options.pointer)
    : null;
  const horizontal = orthogonalPoint?.y === options.orthogonalFrom?.y;
  const ranked: { candidate: SnapCandidate; priority: number; key: string }[] =
    [];
  for (const provider of providers) {
    if (!enabled.has(provider.kind)) continue;
    for (const feature of provider.candidates(context)) {
      if (feature.kind !== provider.kind)
        throw new Error("Провайдер вернул другой тип привязки");
      assertPoint(feature.point);
      const delta = distance(options.pointer, feature.point);
      if (delta > tolerance) continue;
      // Orthogonal constraints win. Do not label an off-axis projection as a snap.
      if (
        options.orthogonalFrom &&
        (horizontal
          ? Math.abs(feature.point.y - options.orthogonalFrom.y)
          : Math.abs(feature.point.x - options.orthogonalFrom.x)) >
          GEOMETRY_EPSILON
      )
        continue;
      const elementIds = [...feature.elementIds].sort();
      const candidate = {
        ...feature,
        point: { ...feature.point },
        elementIds,
        distance: delta,
      };
      ranked.push({
        candidate,
        priority: provider.priority,
        key: JSON.stringify([
          feature.kind,
          elementIds,
          feature.point.x,
          feature.point.y,
        ]),
      });
    }
  }
  // A nearby endpoint takes precedence over a closer arbitrary point on its axis.
  ranked.sort(
    (a, b) =>
      a.priority - b.priority ||
      a.candidate.distance - b.candidate.distance ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const candidate = ranked[0]?.candidate ?? null;
  return {
    point: candidate
      ? { ...candidate.point }
      : options.orthogonalFrom
        ? orthogonalTarget(options.orthogonalFrom, options.pointer)
        : { ...options.pointer },
    candidate,
    candidates: ranked.map((r) => r.candidate),
  };
}
