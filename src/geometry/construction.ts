import { wallSchema, type Point, type Wall } from "../domain/model";
import { snapPoint, type SnapCandidate, type SnapOptions } from "./snapping";
import { createMeasuredWall, orthogonalTarget } from "./walls";
import { distance, GEOMETRY_EPSILON } from "./primitives";

export interface WallConstructionInput {
  id: string;
  floorId: string;
  start: Point;
  pointer: Point;
  length: number | null;
  thickness: number;
  height: number;
  orthogonal: boolean;
  snapping?: Omit<SnapOptions, "pointer" | "floorId" | "orthogonalFrom">;
}
export function constructWall(input: WallConstructionInput): {
  wall: Wall;
  snap: SnapCandidate | null;
} {
  const snapped = input.snapping
    ? snapPoint({
        ...input.snapping,
        pointer: input.pointer,
        floorId: input.floorId,
        orthogonalFrom: input.orthogonal ? input.start : undefined,
      })
    : null;
  const target =
    snapped?.point ??
    (input.orthogonal
      ? orthogonalTarget(input.start, input.pointer)
      : input.pointer);
  const wall =
    input.length !== null
      ? createMeasuredWall({ ...input, toward: target, length: input.length })
      : wallSchema.parse({
          id: input.id,
          floorId: input.floorId,
          kind: "wall",
          start: input.start,
          end: target,
          measuredLength: null,
          thickness: input.thickness,
          height: input.height,
          roomIds: [],
          metadata: {},
        });
  if (distance(wall.start, wall.end) === 0)
    throw new RangeError("Укажите ненулевое направление стены");
  // A manual length wins over snapping. Show a snap marker only at the actual endpoint.
  const finalSnap =
    input.length !== null && input.snapping
      ? snapPoint({
          ...input.snapping,
          pointer: wall.end,
          floorId: input.floorId,
          orthogonalFrom: input.orthogonal ? input.start : undefined,
        })
      : snapped;
  const candidate = finalSnap?.candidate ?? null;
  return {
    wall,
    snap:
      candidate && distance(candidate.point, wall.end) <= GEOMETRY_EPSILON
        ? candidate
        : null,
  };
}
