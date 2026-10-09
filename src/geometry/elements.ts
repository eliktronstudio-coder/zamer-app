import {
  constructionElementSchema,
  type ConstructionElement,
  type ColumnSection,
  type Point,
  type Wall,
  type Opening,
} from "../domain/model";
import { distance, GEOMETRY_EPSILON } from "./primitives";
import { nearestOnSegment, intersectSegments } from "./segments";

export function localToWorld(
  point: Point,
  position: Point,
  rotation: number,
): Point {
  const angle = (rotation * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle);
  return {
    x: position.x + point.x * c - point.y * s,
    y: position.y + point.x * s + point.y * c,
  };
}
export function rectangle(width: number, depth: number): Point[] {
  return [
    { x: -width / 2, y: -depth / 2 },
    { x: width / 2, y: -depth / 2 },
    { x: width / 2, y: depth / 2 },
    { x: -width / 2, y: depth / 2 },
  ];
}
export function sectionContours(section: ColumnSection): Point[][] {
  if (section.kind === "polygon") return [section.vertices];
  if (section.kind === "composite")
    return section.parts.flatMap((p) =>
      sectionContours(p.section).map((contour) =>
        contour.map((v) => localToWorld(v, p.position, p.rotation)),
      ),
    );
  if (section.kind === "circle" || section.kind === "ellipse") {
    const w = section.kind === "circle" ? section.diameter : section.width,
      d = section.kind === "circle" ? section.diameter : section.depth;
    return [
      Array.from({ length: 64 }, (_, i) => ({
        x: (Math.cos((i * 2 * Math.PI) / 64) * w) / 2,
        y: (Math.sin((i * 2 * Math.PI) / 64) * d) / 2,
      })),
    ];
  }
  if (section.kind === "rectangle")
    return [rectangle(section.width, section.depth)];
  const { width: w, depth: d, web: t, flange: f, profile } = section;
  let pts: number[][];
  switch (profile) {
    case "L":
      pts = [
        [0, 0],
        [w, 0],
        [w, f],
        [t, f],
        [t, d],
        [0, d],
      ];
      break;
    case "T":
      pts = [
        [0, 0],
        [w, 0],
        [w, f],
        [(w + t) / 2, f],
        [(w + t) / 2, d],
        [(w - t) / 2, d],
        [(w - t) / 2, f],
        [0, f],
      ];
      break;
    case "H":
      pts = [
        [0, 0],
        [w, 0],
        [w, f],
        [(w + t) / 2, f],
        [(w + t) / 2, d - f],
        [w, d - f],
        [w, d],
        [0, d],
        [0, d - f],
        [(w - t) / 2, d - f],
        [(w - t) / 2, f],
        [0, f],
      ];
      break;
    case "U":
      pts = [
        [0, 0],
        [w, 0],
        [w, f],
        [t, f],
        [t, d - f],
        [w, d - f],
        [w, d],
        [0, d],
      ];
      break;
    case "cross":
      pts = [
        [(w - t) / 2, 0],
        [(w + t) / 2, 0],
        [(w + t) / 2, (d - f) / 2],
        [w, (d - f) / 2],
        [w, (d + f) / 2],
        [(w + t) / 2, (d + f) / 2],
        [(w + t) / 2, d],
        [(w - t) / 2, d],
        [(w - t) / 2, (d + f) / 2],
        [0, (d + f) / 2],
        [0, (d - f) / 2],
        [(w - t) / 2, (d - f) / 2],
      ];
      break;
    case "box":
      return [rectangle(w, d), rectangle(w - 2 * t, d - 2 * f).reverse()];
  }
  return [pts.map(([x, y]) => ({ x: x - w / 2, y: y - d / 2 }))];
}
export function polygonError(
  points: readonly Point[],
  closed = true,
): string | null {
  if (points.length < (closed ? 3 : 2)) return "Недостаточно точек контура";
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    const a = { start: points[i], end: points[(i + 1) % points.length] };
    if (distance(a.start, a.end) <= GEOMETRY_EPSILON)
      return "Совпадающие точки контура";
    for (let j = i + 1; j < count; j++) {
      if (j === i + 1 || (closed && i === 0 && j === count - 1)) continue;
      const b = { start: points[j], end: points[(j + 1) % points.length] };
      if (intersectSegments(a, b).kind !== "none")
        return "Контур пересекает сам себя";
    }
  }
  if (closed) {
    const origin = points[0];
    const area =
      points.reduce((sum, p, i) => {
        const q = points[(i + 1) % points.length];
        return (
          sum +
          (p.x - origin.x) * (q.y - origin.y) -
          (q.x - origin.x) * (p.y - origin.y)
        );
      }, 0) / 2;
    if (Math.abs(area) <= GEOMETRY_EPSILON ** 2)
      return "Контур имеет нулевую площадь";
  }
  return null;
}
export function sectionError(section: ColumnSection, depth = 0): string | null {
  if (depth > 4) return "Слишком много вложенных сечений";
  if (section.kind === "polygon") return polygonError(section.vertices);
  if (section.kind === "composite")
    return (
      section.parts
        .map((p) => sectionError(p.section, depth + 1))
        .find(Boolean) ?? null
    );
  if (section.kind === "profile") {
    if (
      section.web >= section.width ||
      section.flange >= section.depth ||
      (["H", "U", "box"].includes(section.profile) &&
        2 * section.flange >= section.depth) ||
      (section.profile === "box" && 2 * section.web >= section.width)
    )
      return "Толщины профиля превышают размеры сечения";
  }
  return null;
}
export function parseElement(input: unknown): ConstructionElement {
  const parsed = constructionElementSchema.safeParse(input);
  if (!parsed.success)
    throw new Error(
      "Проверьте параметры: размеры должны быть положительными, координаты и отметки — конечными числами",
    );
  const e = parsed.data;
  const error =
    e.kind === "column"
      ? sectionError(e.section)
      : e.kind === "levelChange"
        ? polygonError(e.boundary, e.boundary.length > 2)
        : e.kind === "beam" && distance(e.start, e.end) <= GEOMETRY_EPSILON
          ? "Балка имеет нулевую длину"
          : null;
  if (error) throw new Error(error);
  return e;
}
export function openingProblems(
  opening: Opening,
  walls: readonly Wall[],
  elements: readonly ConstructionElement[] = [],
): string[] {
  const wall = walls.find((w) => w.id === opening.wallId);
  if (!wall || wall.floorId !== opening.floorId)
    return ["Проём потерял связь со стеной"];
  const problems: string[] = [];
  if (
    opening.offset + opening.width >
    distance(wall.start, wall.end) + GEOMETRY_EPSILON
  )
    problems.push("Проём выходит за длину стены");
  if (opening.sill + opening.height > wall.height + GEOMETRY_EPSILON)
    problems.push("Проём выходит за высоту стены");
  if (
    elements.some(
      (e) =>
        e.kind === "opening" &&
        e.id !== opening.id &&
        e.wallId === opening.wallId &&
        Math.min(e.offset + e.width, opening.offset + opening.width) -
          Math.max(e.offset, opening.offset) >
          GEOMETRY_EPSILON &&
        Math.min(e.sill + e.height, opening.sill + opening.height) -
          Math.max(e.sill, opening.sill) >
          GEOMETRY_EPSILON,
    )
  )
    problems.push("Проёмы перекрываются");
  return problems;
}
export function openingSegment(
  opening: Opening,
  walls: readonly Wall[],
): { start: Point; end: Point; wall: Wall } | null {
  const wall = walls.find((w) => w.id === opening.wallId);
  if (!wall) return null;
  const length = distance(wall.start, wall.end);
  if (length <= GEOMETRY_EPSILON) return null;
  const at = (offset: number) => ({
    x: wall.start.x + ((wall.end.x - wall.start.x) * offset) / length,
    y: wall.start.y + ((wall.end.y - wall.start.y) * offset) / length,
  });
  return {
    start: at(opening.offset),
    end: at(opening.offset + opening.width),
    wall,
  };
}
function inside(point: Point, polygon: Point[]): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      result = !result;
  }
  return result;
}
function hitSection(
  point: Point,
  section: ColumnSection,
  tolerance: number,
): boolean {
  if (section.kind === "composite")
    return section.parts.some((p) =>
      hitSection(
        localToWorld(
          { x: point.x - p.position.x, y: point.y - p.position.y },
          { x: 0, y: 0 },
          -p.rotation,
        ),
        p.section,
        tolerance,
      ),
    );
  const contours = sectionContours(section);
  return (
    contours.reduce((count, p) => count + Number(inside(point, p)), 0) % 2 ===
      1 ||
    contours.some((p) =>
      p.some(
        (a, i) =>
          nearestOnSegment(point, { start: a, end: p[(i + 1) % p.length] })
            .distance <= tolerance,
      ),
    )
  );
}
export function elementHit(
  e: ConstructionElement,
  point: Point,
  walls: readonly Wall[],
  tolerance: number,
): boolean {
  if (e.kind === "opening") {
    const s = openingSegment(e, walls);
    return (
      !!s &&
      nearestOnSegment(point, s).distance <= s.wall.thickness / 2 + tolerance
    );
  }
  if (e.kind === "beam")
    return nearestOnSegment(point, e).distance <= e.width / 2 + tolerance;
  if (e.kind === "levelChange")
    return (
      (e.boundary.length > 2 && inside(point, e.boundary)) ||
      e.boundary.slice(0, e.boundary.length > 2 ? undefined : -1).some(
        (p, i) =>
          nearestOnSegment(point, {
            start: p,
            end: e.boundary[(i + 1) % e.boundary.length],
          }).distance <= tolerance,
      )
    );
  const local = localToWorld(
    { x: point.x - e.position.x, y: point.y - e.position.y },
    { x: 0, y: 0 },
    -e.rotation,
  );
  return hitSection(
    local,
    e.kind === "column"
      ? e.section
      : { kind: "rectangle", width: e.length, depth: e.width },
    tolerance,
  );
}
export function translateElement(
  e: ConstructionElement,
  delta: Point,
  walls: readonly Wall[],
): ConstructionElement {
  if (e.kind === "opening") {
    const wall = walls.find((w) => w.id === e.wallId);
    if (!wall) throw new Error("Стена не найдена");
    const length = distance(wall.start, wall.end);
    return parseElement({
      ...e,
      offset:
        e.offset +
        (delta.x * (wall.end.x - wall.start.x) +
          delta.y * (wall.end.y - wall.start.y)) /
          length,
    });
  }
  if (e.kind === "beam")
    return parseElement({
      ...e,
      start: { x: e.start.x + delta.x, y: e.start.y + delta.y },
      end: { x: e.end.x + delta.x, y: e.end.y + delta.y },
    });
  if (e.kind === "levelChange")
    return parseElement({
      ...e,
      boundary: e.boundary.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y })),
    });
  return parseElement({
    ...e,
    position: { x: e.position.x + delta.x, y: e.position.y + delta.y },
  });
}
export function elementPoints(
  e: ConstructionElement,
  walls: readonly Wall[],
): Point[] {
  if (e.kind === "opening") {
    const s = openingSegment(e, walls);
    return s ? [s.start, s.end] : [];
  }
  if (e.kind === "beam") return [e.start, e.end];
  if (e.kind === "levelChange") return e.boundary;
  return (
    e.kind === "column"
      ? sectionContours(e.section).flat()
      : rectangle(e.length, e.width)
  ).map((p) => localToWorld(p, e.position, e.rotation));
}
