import { overlappingSegmentPairs } from "./bounds";
import type { Point, RoomEdge, Wall } from "../domain/model";
import { GEOMETRY_EPSILON as EPS, distance, polygonArea } from "./primitives";
import { intersectSegments, nearestOnSegment, projectToLine } from "./segments";
import { polygonError } from "./elements";
export interface DetectedRoom {
  sourceKey: string;
  floorId: string;
  wallIds: string[];
  boundary: Point[];
  holes: Point[][];
  edges: RoomEdge[][];
}
export interface TopologyResult {
  candidates: DetectedRoom[];
  problems: string[];
}
export function signedArea(points: readonly Point[]): number {
  const origin = points[0];
  if (!origin) return 0;
  return (
    points.reduce((sum, p, i) => {
      const q = points[(i + 1) % points.length];
      return (
        sum +
        (p.x - origin.x) * (q.y - origin.y) -
        (q.x - origin.x) * (p.y - origin.y)
      );
    }, 0) / 2
  );
}
export function pointInRing(
  point: Point,
  ring: readonly Point[],
  includeBoundary = true,
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j],
      b = ring[i];
    if (nearestOnSegment(point, { start: a, end: b }).distance <= EPS)
      return includeBoundary;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}
export function pointInRoom(
  point: Point,
  room: Pick<DetectedRoom, "boundary" | "holes">,
): boolean {
  return (
    pointInRing(point, room.boundary) &&
    !room.holes.some((hole) => pointInRing(point, hole))
  );
}
export function roomLabelPoint(
  room: Pick<DetectedRoom, "boundary" | "holes">,
): Point {
  const ring = room.boundary,
    origin = ring[0];
  if (!origin) return { x: 0, y: 0 };
  const centroid = {
    x: ring.reduce((s, p) => s + p.x - origin.x, 0) / ring.length + origin.x,
    y: ring.reduce((s, p) => s + p.y - origin.y, 0) / ring.length + origin.y,
  };
  if (pointInRoom(centroid, room)) return centroid;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length],
      length = distance(a, b),
      step = Math.min(length * 0.001, 0.001);
    const p = {
      x: (a.x + b.x) / 2 - ((b.y - a.y) / length) * step,
      y: (a.y + b.y) / 2 + ((b.x - a.x) / length) * step,
    };
    if (pointInRoom(p, room)) return p;
  }
  return origin;
}
interface Edge {
  a: number;
  b: number;
  wallId: string;
  from: number;
  to: number;
}
export function detectRooms(walls: readonly Wall[]): TopologyResult {
  const candidates: DetectedRoom[] = [],
    problems: string[] = [];
  for (const floorId of [...new Set(walls.map((w) => w.floorId))].sort()) {
    const list = walls
      .filter((w) => w.floorId === floorId)
      .sort((a, b) => a.id.localeCompare(b.id));
    const splits = list.map((w) => [
        { t: 0, point: w.start },
        { t: 1, point: w.end },
      ]),
      bad = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      if (distance(list[i].start, list[i].end) <= EPS) {
        bad.add(list[i].id);
        problems.push("Стена нулевой длины");
      }
    }
    for (const [i, j] of overlappingSegmentPairs(list)) {
      const a = list[i],
        b = list[j];
      const cross = intersectSegments(a, b);
      if (cross.kind === "overlap") {
        bad.add(a.id);
        bad.add(b.id);
        problems.push("Стены накладываются друг на друга");
        continue;
      }
      if (cross.kind !== "point") continue;
      const ta = projectToLine(cross.point, a).parameter,
        tb = projectToLine(cross.point, b).parameter;
      const interiorA =
          distance(cross.point, a.start) > EPS &&
          distance(cross.point, a.end) > EPS,
        interiorB =
          distance(cross.point, b.start) > EPS &&
          distance(cross.point, b.end) > EPS;
      if (interiorA && interiorB) {
        bad.add(a.id);
        bad.add(b.id);
        problems.push("Пересекающиеся стены требуют явного разделения в узле");
      }
      splits[i].push({ t: Math.max(0, Math.min(1, ta)), point: cross.point });
      splits[j].push({ t: Math.max(0, Math.min(1, tb)), point: cross.point });
    }
    const nodes: Point[] = [],
      edges: Edge[] = [],
      neighbors: number[][] = [];
    const buckets = new Map<string, number[]>();
    const unindexed: number[] = [];
    const cell = EPS * 4;
    function node(point: Point) {
      const bx = Math.floor(point.x / cell),
        by = Math.floor(point.y / cell);
      const safe = Math.abs(bx) < 2 ** 50 && Math.abs(by) < 2 ** 50;
      let index = -1;
      if (safe) {
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++)
            for (const candidate of buckets.get(`${bx + dx}:${by + dy}`) ?? [])
              if (
                (index < 0 || candidate < index) &&
                distance(nodes[candidate], point) <= EPS
              )
                index = candidate;
        for (const candidate of unindexed)
          if (
            (index < 0 || candidate < index) &&
            distance(nodes[candidate], point) <= EPS
          )
            index = candidate;
      } else index = nodes.findIndex((p) => distance(p, point) <= EPS);
      if (index < 0) {
        index = nodes.length;
        nodes.push({ ...point });
        neighbors.push([]);
        if (safe) {
          const key = `${bx}:${by}`,
            bucket = buckets.get(key) ?? [];
          bucket.push(index);
          buckets.set(key, bucket);
        } else unindexed.push(index);
      }
      return index;
    }
    for (let i = 0; i < list.length; i++) {
      const points = splits[i].sort((a, b) => a.t - b.t);
      for (let j = 0; j < points.length - 1; j++) {
        const a = node(points[j].point),
          b = node(points[j + 1].point);
        if (a === b) continue;
        const index = edges.length;
        edges.push({
          a,
          b,
          wallId: list[i].id,
          from: points[j].t,
          to: points[j + 1].t,
        });
        neighbors[a].push(index);
        neighbors[b].push(index);
      }
    }
    // Bridges and dangling walls do not delimit a floor face.
    const times = Array(nodes.length).fill(-1) as number[],
      low = Array(nodes.length).fill(0) as number[],
      bridges = new Set<number>();
    let clock = 0;
    function visit(v: number, parentEdge = -1) {
      times[v] = low[v] = clock++;
      for (const id of neighbors[v]) {
        if (id === parentEdge) continue;
        const e = edges[id],
          to = e.a === v ? e.b : e.a;
        if (times[to] < 0) {
          visit(to, id);
          low[v] = Math.min(low[v], low[to]);
          if (low[to] > times[v]) bridges.add(id);
        } else low[v] = Math.min(low[v], times[to]);
      }
    }
    for (let v = 0; v < nodes.length; v++) if (times[v] < 0) visit(v);
    if (bridges.size) problems.push("Есть незамкнутые участки стен");
    const outgoing = nodes.map((p, v) =>
      neighbors[v]
        .filter((id) => !bridges.has(id))
        .map((id) => ({
          id,
          to: edges[id].a === v ? edges[id].b : edges[id].a,
        }))
        .sort(
          (a, b) =>
            Math.atan2(nodes[a.to].y - p.y, nodes[a.to].x - p.x) -
            Math.atan2(nodes[b.to].y - p.y, nodes[b.to].x - p.x),
        ),
    );
    const visited = new Set<string>();
    const faces: DetectedRoom[] = [];
    for (let id = 0; id < edges.length; id++)
      for (const startNode of [edges[id].a, edges[id].b]) {
        if (bridges.has(id) || visited.has(`${id}:${startNode}`)) continue;
        const boundary: Point[] = [],
          refs: RoomEdge[] = [];
        let v = startNode,
          current = id,
          closed = false;
        for (let steps = 0; steps <= edges.length * 2; steps++) {
          const key = `${current}:${v}`;
          if (visited.has(key)) {
            closed = current === id && v === startNode;
            break;
          }
          visited.add(key);
          const e = edges[current],
            to = e.a === v ? e.b : e.a;
          boundary.push(nodes[v]);
          refs.push({
            wallId: e.wallId,
            from: e.a === v ? e.from : e.to,
            to: e.a === v ? e.to : e.from,
          });
          const next = outgoing[to],
            reverse = next.findIndex((item) => item.id === current);
          if (reverse < 0 || !next.length) break;
          current = next[(reverse - 1 + next.length) % next.length].id;
          v = to;
        }
        if (
          !closed ||
          boundary.length < 3 ||
          signedArea(boundary) <= EPS ** 2 ||
          polygonError(boundary)
        )
          continue;
        if (refs.some((r) => bad.has(r.wallId))) continue;
        const wallIds = [...new Set(refs.map((r) => r.wallId))].sort();
        faces.push({
          sourceKey: wallIds.join(":"),
          floorId,
          wallIds,
          boundary,
          holes: [],
          edges: [refs],
        });
      }
    // Separate enclosed components are holes in the immediately containing face.
    const parent = faces.map(
      (face, i) =>
        faces
          .map((outer, j) => ({ j, area: polygonArea(outer.boundary) }))
          .filter(
            ({ j, area }) =>
              j !== i &&
              area > polygonArea(face.boundary) &&
              face.boundary.every((p) =>
                pointInRing(p, faces[j].boundary, false),
              ),
          )
          .sort((a, b) => a.area - b.area)[0]?.j,
    );
    for (let i = 0; i < faces.length; i++) {
      const holes = faces.filter((_, j) => parent[j] === i);
      const edges = [
        faces[i].edges[0],
        ...holes.map((h) =>
          h.edges[0]
            .slice()
            .reverse()
            .map((e) => ({ ...e, from: e.to, to: e.from })),
        ),
      ];
      const wallIds = [...new Set(edges.flat().map((r) => r.wallId))].sort();
      candidates.push({
        ...faces[i],
        sourceKey: wallIds.join(":"),
        wallIds,
        holes: holes.map((h) => [
          h.boundary[0],
          ...h.boundary.slice(1).reverse(),
        ]),
        edges,
      });
    }
  }
  return {
    candidates: candidates.sort((a, b) =>
      a.sourceKey.localeCompare(b.sourceKey),
    ),
    problems: [...new Set(problems)],
  };
}

/** Stored closed rooms must describe an actual face, never an arbitrary polygon. */
export function assertRoomContours(
  rooms: readonly import("../domain/model").Room[],
  walls: readonly Wall[],
): void {
  if (!rooms.some((room) => room.geometricallyClosed)) return;
  const candidates = detectRooms(walls).candidates;
  const used = new Set<string>();
  const sameRing = (a: readonly Point[], b: readonly Point[]) =>
    a.length === b.length &&
    b.some((_, start) =>
      [1, -1].some((direction) =>
        a.every(
          (point, i) =>
            distance(point, b[(start + direction * i + b.length) % b.length]) <=
            EPS,
        ),
      ),
    );
  const edgeKey = (edge: RoomEdge) =>
    `${edge.wallId}:${Math.min(edge.from, edge.to)}:${Math.max(edge.from, edge.to)}`;
  for (const room of rooms.filter((room) => room.geometricallyClosed)) {
    const key = `${room.floorId}:${room.sourceKey}`;
    const face = candidates.find(
      (face) =>
        face.floorId === room.floorId && face.sourceKey === room.sourceKey,
    );
    if (
      !face ||
      used.has(key) ||
      !sameRing(room.boundary, face.boundary) ||
      room.holes.length !== face.holes.length ||
      !room.holes.every((hole) =>
        face.holes.some((other) => sameRing(hole, other)),
      ) ||
      JSON.stringify([...room.wallIds].sort()) !==
        JSON.stringify([...face.wallIds].sort()) ||
      JSON.stringify(room.edges.flat().map(edgeKey).sort()) !==
        JSON.stringify(face.edges.flat().map(edgeKey).sort())
    ) {
      throw new Error("Сохранённый контур помещения не соответствует стенам");
    }
    used.add(key);
  }
}
