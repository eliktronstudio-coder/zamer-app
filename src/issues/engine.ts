import { overlappingSegmentPairs } from "../geometry/bounds";
import * as clipping from "polygon-clipping";
import { elementFootprint, geometryArea } from "../calculation/quantities";
import type { EndpointReference, Point } from "../domain/model";
import type { GeometryScene } from "../geometry/constraints";
import { validateScene, translateSceneWall } from "../geometry/constraints";
import { distance, GEOMETRY_EPSILON as EPS } from "../geometry/primitives";
import { intersectSegments, nearestOnSegment } from "../geometry/segments";
import {
  openingProblems,
  elementPoints,
  localToWorld,
} from "../geometry/elements";
import { CalculationEngine } from "../calculation/engine";
import { deleteElement } from "../editor/commands";
export interface Repair {
  kind: "connect-gap" | "delete-duplicate";
  label: string;
  explanation: string;
  source: string;
  wallId: string;
  delta?: Point;
  endpoints?: [EndpointReference, EndpointReference];
}
export interface PlanIssue {
  id: string;
  ruleId: string;
  severity: "info" | "warning" | "error";
  floorId: string;
  roomIds: string[];
  elementIds: string[];
  description: string;
  point: Point;
  repair?: Repair;
}
export interface RuleContext {
  floorId: string;
  scene: GeometryScene;
  height: number;
}
export interface IssueRule {
  id: string;
  evaluate: (context: RuleContext) => PlanIssue[];
}
export const sceneFingerprint = (scene: GeometryScene) => JSON.stringify(scene);
function issue(
  c: RuleContext,
  ruleId: string,
  ids: string[],
  description: string,
  point: Point,
  severity: PlanIssue["severity"] = "warning",
  detail = "",
): PlanIssue {
  const entities = [
    ...c.scene.walls,
    ...(c.scene.elements ?? []),
    ...c.scene.dimensions,
  ];
  return {
    id: [c.floorId, ruleId, ...[...ids].sort(), detail].join("|"),
    ruleId,
    severity,
    floorId: c.floorId,
    elementIds: ids,
    roomIds: [
      ...new Set([
        ...entities.filter((e) => ids.includes(e.id)).flatMap((e) => e.roomIds),
        ...(c.scene.rooms ?? [])
          .filter(
            (r) =>
              ids.includes(r.id) || r.wallIds.some((id) => ids.includes(id)),
          )
          .map((r) => r.id),
      ]),
    ],
    description,
    point,
  };
}
export function focusPoints(
  scene: GeometryScene,
  id: string | undefined,
  fallback: Point = { x: 0, y: 0 },
): Point[] {
  const wall = scene.walls.find((w) => w.id === id);
  if (wall) return [wall.start, wall.end];
  const room = scene.rooms?.find((r) => r.id === id);
  if (room) return room.boundary;
  const element = scene.elements?.find((e) => e.id === id);
  if (element) {
    const points = elementPoints(element, scene.walls);
    if (points.length) return points;
  }
  const dimension = scene.dimensions.find((d) => d.id === id);
  if (dimension) {
    const source = scene.walls.find((w) => w.id === dimension.from.elementId);
    return source ? [source.start, source.end] : [fallback];
  }
  return [fallback];
}
const modelRule: IssueRule = {
  id: "model",
  evaluate: (c) =>
    validateScene(c.scene).map((p) =>
      issue(
        c,
        p.code,
        p.elementIds,
        p.message,
        focusPoints(c.scene, p.elementIds[0])[0],
        "error",
      ),
    ),
};
const openingRule: IssueRule = {
  id: "opening",
  evaluate: (c) =>
    (c.scene.elements ?? []).flatMap((e) =>
      e.kind === "opening"
        ? openingProblems(e, c.scene.walls, c.scene.elements).map(
            (message, i) =>
              issue(
                c,
                "opening",
                [e.id],
                message,
                focusPoints(c.scene, e.id)[0],
                "error",
                String(i),
              ),
          )
        : [],
    ),
};
function unsafeIntersections(scene: GeometryScene): Set<string> {
  const result = new Set<string>();
  for (const [i, j] of overlappingSegmentPairs(scene.walls)) {
    const a = scene.walls[i],
      b = scene.walls[j],
      hit = intersectSegments(a, b);
    if (
      hit.kind === "overlap" ||
      (hit.kind === "point" &&
        [a, b].every(
          (w) =>
            distance(hit.point, w.start) > EPS &&
            distance(hit.point, w.end) > EPS,
        ))
    )
      result.add([a.id, b.id].sort().join(":"));
  }
  return result;
}
function introducesIntersection(
  before: GeometryScene,
  after: GeometryScene,
): boolean {
  const old = unsafeIntersections(before);
  return [...unsafeIntersections(after)].some((key) => !old.has(key));
}
const wallRule: IssueRule = {
  id: "wall-topology",
  evaluate: (c) => {
    const result: PlanIssue[] = [],
      walls = [...c.scene.walls].sort((a, b) => a.id.localeCompare(b.id));
    for (const [i, j] of overlappingSegmentPairs(walls)) {
      const a = walls[i],
        b = walls[j];
      if (a.floorId !== b.floorId) continue;
      const hit = intersectSegments(a, b);
      if (hit.kind === "overlap") {
        const duplicate =
          (distance(a.start, b.start) <= EPS &&
            distance(a.end, b.end) <= EPS) ||
          (distance(a.start, b.end) <= EPS && distance(a.end, b.start) <= EPS);
        const row = issue(
          c,
          duplicate ? "duplicate-wall" : "wall-overlap",
          [a.id, b.id],
          duplicate
            ? "Две стены полностью совпадают"
            : "Стены накладываются на одном участке",
          hit.start,
          "error",
        );
        const attached =
          (c.scene.elements ?? []).some(
            (e) => e.kind === "opening" && e.wallId === b.id,
          ) ||
          c.scene.dimensions.some(
            (d) => d.from.elementId === b.id || d.to.elementId === b.id,
          ) ||
          c.scene.junctions.some((k) =>
            k.endpoints.some((e) => e.elementId === b.id),
          ) ||
          (c.scene.rooms ?? []).some((r) => r.wallIds.includes(b.id));
        if (
          duplicate &&
          a.id !== b.id &&
          !attached &&
          a.height === b.height &&
          a.thickness === b.thickness &&
          a.measuredLength === b.measuredLength &&
          JSON.stringify(a.metadata) === JSON.stringify(b.metadata)
        )
          row.repair = {
            kind: "delete-duplicate",
            label: "Удалить дублирующую стену?",
            explanation:
              "Удалится только дубль без связанных размеров, проёмов и помещений. Первая стена останется.",
            wallId: b.id,
            source: sceneFingerprint(c.scene),
          };
        result.push(row);
      } else if (
        hit.kind === "point" &&
        [a, b].every(
          (w) =>
            distance(hit.point, w.start) > EPS &&
            distance(hit.point, w.end) > EPS,
        )
      )
        result.push(
          issue(
            c,
            "wall-crossing",
            [a.id, b.id],
            "Стены пересекаются внутри участков; проверьте узел",
            hit.point,
            "error",
          ),
        );
    }
    const endpoints = walls.flatMap((w) =>
      (["start", "end"] as const).map((anchor) => ({
        wall: w,
        anchor,
        point: w[anchor],
      })),
    );
    const connected = (e: (typeof endpoints)[number]) =>
      walls.some(
        (w) =>
          w.id !== e.wall.id && nearestOnSegment(e.point, w).distance <= EPS,
      );
    const loose = endpoints.filter((e) => !connected(e));
    const paired = new Set<string>();
    for (let i = 0; i < loose.length; i++)
      for (let j = i + 1; j < loose.length; j++) {
        const a = loose[i],
          b = loose[j],
          gap = distance(a.point, b.point);
        if (a.wall.id === b.wall.id || gap > 0.05 || gap <= EPS) continue;
        const refs: [EndpointReference, EndpointReference] = [
          { elementId: a.wall.id, anchor: a.anchor },
          { elementId: b.wall.id, anchor: b.anchor },
        ];
        paired.add(`${a.wall.id}:${a.anchor}`);
        paired.add(`${b.wall.id}:${b.anchor}`);
        const row = issue(
          c,
          "small-wall-gap",
          [a.wall.id, b.wall.id],
          `Разрыв между концами стен: ${gap.toLocaleString("ru-RU", { maximumFractionDigits: 4 })} м`,
          a.point,
          "warning",
          `${a.anchor}:${b.anchor}`,
        );
        const delta = { x: a.point.x - b.point.x, y: a.point.y - b.point.y },
          preview = translateSceneWall(c.scene, b.wall.id, delta);
        if (
          preview.ok &&
          !introducesIntersection(c.scene, preview.scene) &&
          !c.scene.junctions.some((j) =>
            j.endpoints.some((e) =>
              refs.some(
                (r) => r.elementId === e.elementId && r.anchor === e.anchor,
              ),
            ),
          )
        )
          row.repair = {
            kind: "connect-gap",
            label: "Соединить концы стен?",
            explanation: `Вторая стена сдвинется на ${gap.toLocaleString("ru-RU", { maximumFractionDigits: 4 })} м без изменения её ручной длины. Связанные элементы переместятся вместе с ней.`,
            wallId: b.wall.id,
            delta,
            endpoints: refs,
            source: sceneFingerprint(c.scene),
          };
        result.push(row);
      }
    for (const e of loose)
      if (!paired.has(`${e.wall.id}:${e.anchor}`))
        result.push(
          issue(
            c,
            "open-wall-end",
            [e.wall.id],
            "Свободный конец стены: контур может быть незамкнут",
            e.point,
            "info",
            e.anchor,
          ),
        );
    return result;
  },
};
const roomRule: IssueRule = {
  id: "room-calculation",
  evaluate: (c) => {
    const calculation = new CalculationEngine().evaluate(c.scene, c.height),
      result: PlanIssue[] = [];
    for (const q of calculation.rooms) {
      const room = c.scene.rooms?.find((r) => r.id === q.roomId);
      if (!room) continue;
      q.problems.forEach((description, i) =>
        result.push(
          issue(
            c,
            "room-incomplete",
            [room.id],
            description,
            room.boundary[0] ?? { x: 0, y: 0 },
            room.geometricallyClosed ? "warning" : "error",
            String(i),
          ),
        ),
      );
    }
    for (const face of calculation.topology.candidates)
      if (
        !c.scene.rooms?.some(
          (r) => r.geometricallyClosed && r.sourceKey === face.sourceKey,
        )
      )
        result.push(
          issue(
            c,
            "unregistered-room",
            face.wallIds,
            "Замкнутый контур ещё не добавлен как помещение; он не входит в итог этажа",
            face.boundary[0],
            "info",
            face.sourceKey,
          ),
        );
    if (!calculation.floor.complete)
      result.push(
        issue(
          c,
          "incomplete-calculation",
          [],
          "Расчёт этажа неполный: проверьте помещения, размеры и конструкции",
          { x: 0, y: 0 },
          "warning",
        ),
      );
    return result;
  },
};
const levelsRule: IssueRule = {
  id: "level-consistency",
  evaluate: (c) => {
    const result: PlanIssue[] = [];
    for (const e of c.scene.elements ?? [])
      if (e.kind === "stair" || e.kind === "ramp") {
        const start = e.position,
          end = localToWorld({ x: e.length, y: 0 }, e.position, e.rotation);
        for (const level of c.scene.elements ?? [])
          if (level.kind === "levelChange" && level.boundary.length === 2) {
            let rise: number | undefined;
            if (
              distance(start, level.boundary[0]) <= 0.05 &&
              distance(end, level.boundary[1]) <= 0.05
            )
              rise = level.toElevation - level.fromElevation;
            else if (
              distance(start, level.boundary[1]) <= 0.05 &&
              distance(end, level.boundary[0]) <= 0.05
            )
              rise = level.fromElevation - level.toElevation;
            if (rise !== undefined && Math.abs(e.rise - rise) > 0.001)
              result.push(
                issue(
                  c,
                  "level-mismatch",
                  [e.id, level.id],
                  `${e.kind === "stair" ? "Лестница" : "Пандус"}: перепад ${e.rise} м не соответствует отметкам ${rise} м`,
                  start,
                  "error",
                ),
              );
          }
      }
    return result;
  },
};
const measurementRule: IssueRule = {
  id: "measurements",
  evaluate: (c) =>
    c.scene.walls
      .filter((w) => w.measuredLength === null)
      .map((w) =>
        issue(
          c,
          "missing-measurement",
          [w.id],
          "Не задан ручной размер стены; геометрическая длина не заменяет замер",
          w.start,
          "warning",
        ),
      ),
};
const overlapRule: IssueRule = {
  id: "construction-overlap",
  evaluate: (c) => {
    const elements = (c.scene.elements ?? []).filter(
        (e) => e.kind !== "opening" && e.kind !== "levelChange",
      ),
      result: PlanIssue[] = [];
    for (let i = 0; i < elements.length; i++)
      for (let j = i + 1; j < elements.length; j++) {
        const a = elements[i],
          b = elements[j];
        if (a.kind !== b.kind) continue;
        if (
          a.kind === "beam" &&
          b.kind === "beam" &&
          (a.elevation + a.height <= b.elevation ||
            b.elevation + b.height <= a.elevation)
        )
          continue;
        if (
          geometryArea(
            clipping.intersection(elementFootprint(a), elementFootprint(b)),
          ) >
          EPS ** 2
        )
          result.push(
            issue(
              c,
              "element-overlap",
              [a.id, b.id],
              "Конструкции одного типа пересекаются. Проверьте дубли и допустимость наложения; объёмы суммируются без вычета пересечения",
              focusPoints(c.scene, a.id)[0],
              "warning",
            ),
          );
      }
    return result;
  },
};
export const defaultRules: readonly IssueRule[] = [
  modelRule,
  measurementRule,
  overlapRule,
  wallRule,
  openingRule,
  levelsRule,
  roomRule,
];
export function evaluateIssues(
  context: RuleContext,
  rules: readonly IssueRule[] = defaultRules,
): PlanIssue[] {
  const severity = { error: 0, warning: 1, info: 2 };
  return [
    ...new Map(
      rules
        .flatMap((rule) => {
          try {
            return rule.evaluate(context);
          } catch {
            return [
              issue(
                context,
                "rule-failed",
                [],
                "Не удалось выполнить проверку. Список нестыковок может быть неполным",
                { x: 0, y: 0 },
                "error",
                rule.id,
              ),
            ];
          }
        })
        .map((row) => [row.id, row]),
    ).values(),
  ].sort(
    (a, b) =>
      severity[a.severity] - severity[b.severity] || a.id.localeCompare(b.id),
  );
}
export function applyRepair(
  scene: GeometryScene,
  repair: Repair,
): GeometryScene {
  if (sceneFingerprint(scene) !== repair.source)
    throw new Error("План изменился. Проверьте новое предложение.");
  const sourceWall = scene.walls.find((w) => w.id === repair.wallId);
  const available =
    sourceWall &&
    wallRule
      .evaluate({ scene, floorId: sourceWall.floorId, height: 0 })
      .some(
        (row) =>
          row.repair?.kind === repair.kind &&
          row.repair.wallId === repair.wallId &&
          JSON.stringify(row.repair.delta) === JSON.stringify(repair.delta) &&
          JSON.stringify(row.repair.endpoints) ===
            JSON.stringify(repair.endpoints),
      );
  if (!available)
    throw new Error("Предложение больше недоступно; проверьте связи и размеры");
  if (repair.kind === "delete-duplicate")
    return deleteElement(scene, repair.wallId);
  if (!repair.delta || !repair.endpoints)
    throw new Error("Некорректное предложение");
  const moved = translateSceneWall(scene, repair.wallId, repair.delta);
  if (!moved.ok)
    throw new Error(moved.problems.map((p) => p.message).join("; "));
  if (introducesIntersection(scene, moved.scene))
    throw new Error(
      "Сдвиг создаёт новое пересечение; исправьте геометрию вручную",
    );
  const a = moved.scene.walls.find(
      (w) => w.id === repair.endpoints![0].elementId,
    ),
    b = moved.scene.walls.find((w) => w.id === repair.endpoints![1].elementId);
  if (
    !a ||
    !b ||
    distance(a[repair.endpoints[0].anchor], b[repair.endpoints[1].anchor]) > EPS
  )
    throw new Error("Не удалось соединить концы без нарушения размеров");
  const next = {
    ...moved.scene,
    junctions: [
      ...moved.scene.junctions,
      {
        id: crypto.randomUUID(),
        floorId: a.floorId,
        endpoints: repair.endpoints,
      },
    ],
  };
  const oldProblems = new Set(
    validateScene(scene).map((p) => `${p.code}:${p.elementIds.join(":")}`),
  );
  if (
    validateScene(next).some(
      (p) => !oldProblems.has(`${p.code}:${p.elementIds.join(":")}`),
    )
  )
    throw new Error("Исправление нарушает связи или размеры");
  return next;
}
