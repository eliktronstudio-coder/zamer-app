import * as THREE from "three";
import * as clipping from "polygon-clipping";
import type { Polygon, MultiPolygon } from "polygon-clipping";
import type { Floor, Wall, Opening } from "../../domain/model";
import type { GeometryScene } from "../../geometry/constraints";
import { distance, GEOMETRY_EPSILON } from "../../geometry/primitives";
import { elementFootprint } from "../../calculation/quantities";
export interface ModelWarning {
  id: string;
  message: string;
}
const rect = (x: number, y: number, w: number, h: number): Polygon => [
  [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
    [x, y],
  ],
];
function shapes(polygons: MultiPolygon) {
  return polygons.map((poly) => {
    const shape = new THREE.Shape(
      poly[0].map(([x, y]) => new THREE.Vector2(x, y)),
    );
    shape.holes = poly
      .slice(1)
      .map((r) => new THREE.Path(r.map(([x, y]) => new THREE.Vector2(x, y))));
    return shape;
  });
}
export function wallProfile(w: Wall, openings: readonly Opening[]) {
  const length = distance(w.start, w.end),
    warnings: ModelWarning[] = [];
  const valid = openings.filter((o) => {
    const ok =
      o.offset >= 0 &&
      o.offset + o.width <= length + GEOMETRY_EPSILON &&
      o.sill >= 0 &&
      o.sill + o.height <= w.height + GEOMETRY_EPSILON;
    if (!ok)
      warnings.push({
        id: o.id,
        message: "Проём выходит за стену; вырез не построен",
      });
    return ok;
  });
  const cuts = valid.map((o) => rect(o.offset, o.sill, o.width, o.height));
  const polygons =
    length > GEOMETRY_EPSILON
      ? cuts.length
        ? clipping.difference(rect(0, 0, length, w.height), ...cuts)
        : [rect(0, 0, length, w.height)]
      : [];
  if (!polygons.length)
    warnings.push({
      id: w.id,
      message: "Стена нулевой длины или полностью занята проёмом",
    });
  return { polygons, valid, warnings, length };
}
export function buildFloorModel(scene: GeometryScene, floor: Floor) {
  const group = new THREE.Group(),
    warnings: ModelWarning[] = [];
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  function material(kind: string) {
    let m = materials.get(kind);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color:
          (
            {
              wall: 0xd3dedb,
              column: 0x879f99,
              beam: 0x738b85,
              stair: 0x9cabba,
              ramp: 0xa7b6ac,
              levelChange: 0xb9a688,
              room: 0xdce5df,
              window: 0x68b9d7,
              door: 0xb68d61,
            } as Record<string, number>
          )[kind] ?? 0xbfcfc9,
        roughness: 0.8,
        transparent: kind === "window",
        opacity: kind === "window" ? 0.35 : 1,
        side: THREE.DoubleSide,
      });
      materials.set(kind, m);
    }
    return m;
  }
  function add(geometry: THREE.BufferGeometry, id: string, kind: string) {
    const mesh = new THREE.Mesh(geometry, material(kind));
    mesh.userData = { sourceId: id, kind };
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  }
  function extrude(
    polys: MultiPolygon,
    depth: number,
    id: string,
    kind: string,
  ) {
    return add(
      new THREE.ExtrudeGeometry(shapes(polys), {
        depth,
        bevelEnabled: false,
        steps: 1,
        curveSegments: 24,
      }),
      id,
      kind,
    );
  }
  const openings = (scene.elements ?? []).filter(
    (e): e is Opening => e.kind === "opening",
  );
  for (const w of scene.walls) {
    const profile = wallProfile(
      w,
      openings.filter((o) => o.wallId === w.id),
    );
    warnings.push(...profile.warnings);
    if (profile.length <= GEOMETRY_EPSILON) continue;
    const angle = Math.atan2(w.end.y - w.start.y, w.end.x - w.start.x);
    if (profile.polygons.length) {
      const mesh = extrude(profile.polygons, w.thickness, w.id, "wall");
      mesh.geometry.translate(0, 0, -w.thickness / 2);
      mesh.rotation.y = angle;
      mesh.position.set(w.start.x, floor.elevation, -w.start.y);
    }
    for (const o of profile.valid) {
      if (o.type === "void") continue;
      const fill = add(
        new THREE.BoxGeometry(o.width, o.height, Math.min(w.thickness, 0.035)),
        o.id,
        o.type,
      );
      fill.rotation.y = angle;
      const center = (o.offset + o.width / 2) / profile.length;
      fill.position.set(
        w.start.x + (w.end.x - w.start.x) * center,
        floor.elevation + o.sill + o.height / 2,
        -w.start.y - (w.end.y - w.start.y) * center,
      );
    }
  }
  for (const e of scene.elements ?? []) {
    if (e.kind === "opening") {
      if (!scene.walls.some((w) => w.id === e.wallId))
        warnings.push({ id: e.id, message: "Проём потерял стену" });
      continue;
    }
    if (e.kind === "column" || e.kind === "beam") {
      if (e.kind === "beam" && distance(e.start, e.end) <= GEOMETRY_EPSILON) {
        warnings.push({
          id: e.id,
          message: "Балка нулевой длины не построена",
        });
        continue;
      }
      const m = extrude(elementFootprint(e), e.height, e.id, e.kind);
      m.rotation.x = -Math.PI / 2;
      m.position.y = floor.elevation + (e.kind === "beam" ? e.elevation : 0);
    } else if (e.kind === "stair") {
      for (let i = 0; i < e.steps; i++) {
        const h = ((i + 1) * e.rise) / e.steps,
          len = e.length / e.steps,
          m = add(new THREE.BoxGeometry(len, h, e.width), e.id, e.kind);
        m.rotation.y = (e.rotation * Math.PI) / 180;
        const along = -e.length / 2 + len * (i + 0.5),
          angle = m.rotation.y;
        m.position.set(
          e.position.x + along * Math.cos(angle),
          floor.elevation + h / 2,
          -e.position.y - along * Math.sin(angle),
        );
      }
    } else if (e.kind === "ramp") {
      const base = Math.min(0, e.rise) - 0.08,
        shape: Polygon = [
          [
            [-e.length / 2, base],
            [e.length / 2, base],
            [e.length / 2, e.rise],
            [-e.length / 2, 0],
          ],
        ];
      const m = extrude([shape], e.width, e.id, e.kind);
      m.geometry.translate(0, 0, -e.width / 2);
      m.rotation.y = (e.rotation * Math.PI) / 180;
      m.position.set(e.position.x, floor.elevation, -e.position.y);
    } else {
      if (e.boundary.length > 2) {
        const m = extrude(
          [
            e.boundary.length
              ? [e.boundary.map((p) => [p.x, p.y] as [number, number])]
              : [],
          ],
          0.06,
          e.id,
          e.kind,
        );
        m.rotation.x = -Math.PI / 2;
        m.position.y = floor.elevation + e.toElevation - 0.06;
      } else {
        const a = e.boundary[0],
          b = e.boundary[1],
          len = distance(a, b),
          height = Math.abs(e.toElevation - e.fromElevation);
        if (len > GEOMETRY_EPSILON && height > GEOMETRY_EPSILON) {
          const m = add(new THREE.BoxGeometry(len, height, 0.03), e.id, e.kind);
          m.rotation.y = Math.atan2(b.y - a.y, b.x - a.x);
          m.position.set(
            (a.x + b.x) / 2,
            floor.elevation + (e.fromElevation + e.toElevation) / 2,
            -(a.y + b.y) / 2,
          );
        }
      }
    }
  }
  for (const r of scene.rooms ?? []) {
    if (!r.geometricallyClosed || r.boundary.length < 3) continue;
    const m = extrude(
      [
        [
          r.boundary.map((p) => [p.x, p.y]),
          ...r.holes.map((h) => h.map((p) => [p.x, p.y] as [number, number])),
        ],
      ],
      0.05,
      r.id,
      "room",
    );
    m.rotation.x = -Math.PI / 2;
    m.position.y = floor.elevation - 0.05;
  }
  group.updateMatrixWorld(true);
  return { group, warnings };
}
export function disposeModel(group: THREE.Group) {
  const materials = new Set<THREE.Material>();
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      for (const m of Array.isArray(o.material) ? o.material : [o.material])
        materials.add(m);
    }
  });
  for (const m of materials) m.dispose();
}
