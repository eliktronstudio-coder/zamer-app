import * as clipping from "polygon-clipping";
import type { MultiPolygon, Polygon } from "polygon-clipping";
import type {
  ColumnSection,
  ConstructionElement,
  Opening,
  Point,
  Room,
  Wall,
} from "../domain/model";
import type { GeometryScene } from "../geometry/constraints";
import {
  localToWorld,
  openingProblems,
  rectangle,
  sectionContours,
} from "../geometry/elements";
import {
  distance,
  polygonArea,
  perimeter,
  GEOMETRY_EPSILON as EPS,
} from "../geometry/primitives";
import { lengthMatches } from "../geometry/walls";
import { validateScene } from "../geometry/constraints";
export interface WallQuantity {
  wallId: string;
  length: number;
  height: number;
  grossArea: number;
  openingsArea: number | null;
  netArea: number | null;
  revealLength: number | null;
  revealArea: number | null;
}
export interface RoomQuantities {
  roomId: string;
  complete: boolean;
  problems: string[];
  contourArea: number | null;
  floorArea: number | null;
  ceilingArea: number | null;
  perimeter: number | null;
  height: number;
  volume: number | null;
  grossWallArea: number | null;
  windowArea: number | null;
  doorArea: number | null;
  voidArea: number | null;
  openingsArea: number | null;
  netWallArea: number | null;
  revealLength: number | null;
  revealArea: number | null;
  walls: WallQuantity[];
}
export interface ElementQuantity {
  id: string;
  kind: string;
  volume: number | null;
  surfaceArea: number | null;
  sectionArea: number | null;
  problems: string[];
}
export interface FloorQuantities {
  complete: boolean;
  roomCount: number;
  closedRoomCount: number;
  contourArea: number;
  floorArea: number;
  ceilingArea: number;
  roomVolume: number;
  grossWallArea: number;
  netWallArea: number | null;
  openingArea: number | null;
  wallVolume: number | null;
  constructionVolume: number | null;
  elementCounts: Record<string, number>;
  elements: ElementQuantity[];
}
const ring = (points: readonly Point[]) =>
  points.map((p) => [p.x, p.y] as [number, number]);
const polygon = (points: readonly Point[]): Polygon => [ring(points)];
const roomPolygon = (room: Pick<Room, "boundary" | "holes">): Polygon => [
  ring(room.boundary),
  ...room.holes.map(ring),
];
export function geometryArea(geometry: MultiPolygon): number {
  return geometry.reduce(
    (sum, p) =>
      sum +
      (p.length
        ? polygonArea(p[0].map(([x, y]) => ({ x, y }))) -
          p
            .slice(1)
            .reduce((s, h) => s + polygonArea(h.map(([x, y]) => ({ x, y }))), 0)
        : 0),
    0,
  );
}
export function sectionGeometry(section: ColumnSection): MultiPolygon {
  if (section.kind !== "composite") return [sectionContours(section).map(ring)];
  const parts = section.parts.map((part) =>
    sectionGeometry(part.section).map((poly) =>
      poly.map((contour) =>
        contour.map(([x, y]) => {
          const p = localToWorld({ x, y }, part.position, part.rotation);
          return [p.x, p.y] as [number, number];
        }),
      ),
    ),
  );
  return parts.length ? clipping.union(parts[0], ...parts.slice(1)) : [];
}
export function sectionArea(section: ColumnSection): number {
  if (section.kind === "circle") return (Math.PI * section.diameter ** 2) / 4;
  if (section.kind === "ellipse")
    return (Math.PI * section.width * section.depth) / 4;
  return geometryArea(sectionGeometry(section));
}
export function elementFootprint(element: ConstructionElement): MultiPolygon {
  if (element.kind === "opening" || element.kind === "levelChange") return [];
  if (element.kind === "beam") {
    const length = distance(element.start, element.end),
      position = {
        x: (element.start.x + element.end.x) / 2,
        y: (element.start.y + element.end.y) / 2,
      },
      angle =
        (Math.atan2(
          element.end.y - element.start.y,
          element.end.x - element.start.x,
        ) *
          180) /
        Math.PI;
    return [
      polygon(
        rectangle(length, element.width).map((p) =>
          localToWorld(p, position, angle),
        ),
      ),
    ];
  }
  const shape =
    element.kind === "column"
      ? sectionGeometry(element.section)
      : [polygon(rectangle(element.length, element.width))];
  return shape.map((poly) =>
    poly.map((contour) =>
      contour.map(([x, y]) => {
        const p = localToWorld({ x, y }, element.position, element.rotation);
        return [p.x, p.y] as [number, number];
      }),
    ),
  );
}
export function calculateElement(e: ConstructionElement): ElementQuantity {
  let volume: number | null = null,
    surfaceArea: number | null = null,
    area: number | null = null;
  if (e.kind === "column") {
    area = sectionArea(e.section);
    volume = area * e.height;
    const contours = sectionGeometry(e.section);
    const perimeterValue = contours.reduce(
      (sum, p) =>
        sum +
        p.reduce((s, r) => s + perimeter(r.map(([x, y]) => ({ x, y }))), 0),
      0,
    );
    surfaceArea = perimeterValue * e.height + 2 * area;
  }
  if (e.kind === "beam") {
    const l = distance(e.start, e.end);
    volume = l * e.width * e.height;
    surfaceArea = 2 * (l * e.width + l * e.height + e.width * e.height);
  }
  if (e.kind === "ramp") {
    volume = (e.width * e.length * Math.abs(e.rise)) / 2;
    surfaceArea = e.width * Math.hypot(e.length, e.rise);
  }
  if (e.kind === "stair") {
    volume = (e.width * e.length * e.rise * (e.steps + 1)) / (2 * e.steps);
    surfaceArea = e.width * (e.length + e.rise);
  }
  if (e.kind === "opening") surfaceArea = e.width * e.height;
  const values = [volume, surfaceArea, area];
  const problems = values.some((v) => v !== null && !Number.isFinite(v))
    ? ["Расчёт конструкции вне числового диапазона"]
    : [];
  return {
    id: e.id,
    kind: e.kind,
    volume: problems.length ? null : volume,
    surfaceArea: problems.length ? null : surfaceArea,
    sectionArea: problems.length ? null : area,
    problems,
  };
}
function openingAreaForSegment(
  o: Opening,
  wall: Wall,
  from: number,
  to: number,
  height: number,
) {
  const length = distance(wall.start, wall.end),
    left = Math.min(from, to) * length,
    right = Math.max(from, to) * length;
  const width = Math.max(
    0,
    Math.min(right, o.offset + o.width) - Math.max(left, o.offset),
  );
  const h = Math.max(0, Math.min(height, o.sill + o.height) - o.sill);
  const sideCount =
    Number(o.offset >= left - EPS && o.offset < right - EPS) +
    Number(
      o.offset + o.width > left + EPS && o.offset + o.width <= right + EPS,
    );
  const revealLength = width * (o.sill > EPS ? 2 : 1) + h * sideCount;
  return {
    area: width * h,
    revealLength,
    revealArea: revealLength * (o.revealDepth ?? wall.thickness / 2),
  };
}
export function calculateRoom(
  room: Room,
  scene: GeometryScene,
  defaultHeight: number,
): RoomQuantities {
  const height = room.height ?? defaultHeight,
    problems: string[] = [],
    walls: WallQuantity[] = [];
  const blank = {
    roomId: room.id,
    complete: false,
    problems,
    contourArea: null,
    floorArea: null,
    ceilingArea: null,
    perimeter: null,
    height,
    volume: null,
    grossWallArea: null,
    windowArea: null,
    doorArea: null,
    voidArea: null,
    openingsArea: null,
    netWallArea: null,
    revealLength: null,
    revealArea: null,
    walls,
  };
  if (!room.geometricallyClosed) {
    problems.push(
      "Контур помещения не замкнут или изменился; привяжите его заново",
    );
    return blank;
  }
  if (!room.name.trim()) problems.push("Не задано название помещения");
  if (!Number.isFinite(height) || height <= 0) {
    problems.push("Не задана корректная высота помещения");
    return blank;
  }
  try {
    const geometry = roomPolygon(room),
      contourArea =
        polygonArea(room.boundary) -
        room.holes.reduce((sum, p) => sum + polygonArea(p), 0);
    if (contourArea <= EPS ** 2) {
      problems.push("Некорректная площадь контура");
      return blank;
    }
    const columns = (scene.elements ?? []).filter(
      (e) => e.kind === "column" && e.floorId === room.floorId,
    );
    const floor = columns.length
      ? clipping.difference(geometry, ...columns.map(elementFootprint))
      : [geometry];
    const ceilingColumns = columns.filter(
      (e) => e.kind === "column" && e.height >= height - EPS,
    );
    const ceiling = ceilingColumns.length
      ? clipping.difference(geometry, ...ceilingColumns.map(elementFootprint))
      : [geometry];
    let invalidOpenings = false,
      windowArea = 0,
      doorArea = 0,
      voidArea = 0;
    for (const edges of room.edges)
      for (const edge of edges) {
        const w = scene.walls.find((item) => item.id === edge.wallId);
        if (!w) {
          problems.push("Стена помещения отсутствует");
          return blank;
        }
        if (w.measuredLength === null)
          problems.push("Не все длины стен подтверждены ручным замером");
        else if (!lengthMatches(w, w.measuredLength))
          problems.push("Геометрия стены не совпадает с ручным замером");
        if (Math.abs(w.height - height) > EPS)
          problems.push("Высота стены отличается от высоты помещения");
        const effectiveHeight = Math.min(height, w.height),
          length = distance(w.start, w.end) * Math.abs(edge.to - edge.from);
        let area = 0,
          reveals = 0,
          revealArea = 0,
          valid = true;
        for (const e of scene.elements ?? [])
          if (e.kind === "opening" && e.wallId === w.id) {
            const wallLength = distance(w.start, w.end);
            if (
              Math.min(
                Math.max(edge.from, edge.to) * wallLength,
                e.offset + e.width,
              ) -
                Math.max(Math.min(edge.from, edge.to) * wallLength, e.offset) <=
              EPS
            )
              continue;
            const part = openingAreaForSegment(
              e,
              w,
              edge.from,
              edge.to,
              effectiveHeight,
            );
            const errors = openingProblems(e, scene.walls, scene.elements);
            if (e.sill + e.height > height + EPS)
              errors.push("Проём выходит за высоту помещения");
            if (errors.length) {
              valid = false;
              invalidOpenings = true;
              problems.push(...errors);
            }
            area += part.area;
            reveals += part.revealLength;
            revealArea += part.revealArea;
            if (e.type === "window") windowArea += part.area;
            else if (e.type === "door") doorArea += part.area;
            else voidArea += part.area;
          }
        walls.push({
          wallId: w.id,
          length,
          height: effectiveHeight,
          grossArea: length * effectiveHeight,
          openingsArea: valid ? area : null,
          netArea: valid ? Math.max(0, length * effectiveHeight - area) : null,
          revealLength: valid ? reveals : null,
          revealArea: valid ? revealArea : null,
        });
      }
    const relevant = new Set(room.wallIds);
    for (const issue of validateScene(scene))
      if (issue.elementIds.some((id) => relevant.has(id)))
        problems.push(issue.message);
    const sum = (
      key:
        | "grossArea"
        | "netArea"
        | "openingsArea"
        | "revealLength"
        | "revealArea",
    ) => walls.reduce((s, w) => s + (w[key] ?? 0), 0);
    const result: RoomQuantities = {
      roomId: room.id,
      complete: problems.length === 0,
      problems: [...new Set(problems)],
      contourArea,
      floorArea: geometryArea(floor),
      ceilingArea: geometryArea(ceiling),
      perimeter:
        perimeter(room.boundary) +
        room.holes.reduce((s, p) => s + perimeter(p), 0),
      height,
      volume: contourArea * height,
      grossWallArea: sum("grossArea"),
      windowArea: invalidOpenings ? null : windowArea,
      doorArea: invalidOpenings ? null : doorArea,
      voidArea: invalidOpenings ? null : voidArea,
      openingsArea: invalidOpenings ? null : sum("openingsArea"),
      netWallArea: invalidOpenings ? null : sum("netArea"),
      revealLength: invalidOpenings ? null : sum("revealLength"),
      revealArea: invalidOpenings ? null : sum("revealArea"),
      walls,
    };
    if (
      Object.values(result).some(
        (v) => typeof v === "number" && !Number.isFinite(v),
      )
    ) {
      problems.push("Расчёт вне числового диапазона");
      return blank;
    }
    return result;
  } catch {
    problems.push("Не удалось вычислить контур; проверьте геометрию");
    return blank;
  }
}
export function calculateFloor(
  scene: GeometryScene,
  rooms: RoomQuantities[],
): FloorQuantities {
  const elements = (scene.elements ?? []).map(calculateElement),
    counts: Record<string, number> = { wall: scene.walls.length };
  for (const e of scene.elements ?? []) {
    const key = e.kind === "opening" ? e.type : e.kind;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const openings = (scene.elements ?? []).filter(
      (e): e is Opening => e.kind === "opening",
    ),
    bad = openings.some(
      (e) => openingProblems(e, scene.walls, scene.elements).length > 0,
    );
  const openingArea = bad
    ? null
    : openings.reduce((sum, o) => sum + o.width * o.height, 0);
  const wallVolume = bad
    ? null
    : scene.walls.reduce(
        (sum, w) =>
          sum +
          distance(w.start, w.end) * w.thickness * w.height -
          openings
            .filter((o) => o.wallId === w.id)
            .reduce((s, o) => s + o.width * o.height * w.thickness, 0),
        0,
      );
  const sum = (
    key:
      | "contourArea"
      | "floorArea"
      | "ceilingArea"
      | "volume"
      | "grossWallArea"
      | "netWallArea",
  ) => rooms.reduce((s, r) => s + (r[key] ?? 0), 0);
  const known = rooms.filter((r) => r.contourArea !== null);
  return {
    complete:
      rooms.every((r) => r.complete) &&
      !bad &&
      elements.every((e) => !e.problems.length),
    roomCount: scene.rooms?.length ?? 0,
    closedRoomCount: known.length,
    contourArea: sum("contourArea"),
    floorArea: sum("floorArea"),
    ceilingArea: sum("ceilingArea"),
    roomVolume: sum("volume"),
    grossWallArea: sum("grossWallArea"),
    netWallArea: known.some((r) => r.netWallArea === null)
      ? null
      : sum("netWallArea"),
    openingArea,
    wallVolume,
    constructionVolume:
      wallVolume === null || elements.some((e) => e.problems.length)
        ? null
        : wallVolume + elements.reduce((s, e) => s + (e.volume ?? 0), 0),
    elementCounts: counts,
    elements,
  };
}
