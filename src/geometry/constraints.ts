import {
  dimensionSchema,
  junctionSchema,
  wallSchema,
  type ConstructionElement,
  type Dimension,
  type EndpointReference,
  type Junction,
  type Point,
  type Wall,
  type Room,
} from "../domain/model";
import { evaluateDimension, resolveReference } from "./dimensions";
import { distance, GEOMETRY_EPSILON } from "./primitives";
import {
  lengthMatches,
  rotateWall,
  setWallLength,
  translateWall,
} from "./walls";
import { assertPoint, assertPositive } from "./vector";

export interface GeometryScene {
  rooms?: readonly Room[];
  elements?: readonly ConstructionElement[];
  walls: readonly Wall[];
  junctions: readonly Junction[];
  dimensions: readonly Dimension[];
}
export interface GeometryProblem {
  code:
    | "invalid-model"
    | "duplicate-id"
    | "missing-element"
    | "wrong-floor"
    | "duplicate-endpoint"
    | "disconnected-junction"
    | "degenerate-wall"
    | "measured-length-conflict"
    | "dimension-conflict"
    | "unsupported-driving-dimension";
  elementIds: string[];
  message: string;
}
export type GeometryCommandResult =
  | {
      ok: true;
      scene: GeometryScene;
      problems: GeometryProblem[];
      changedWallIds: string[];
      changedDimensionIds: string[];
    }
  | { ok: false; problems: GeometryProblem[] };
const refKey = (reference: EndpointReference) =>
  `${reference.elementId}:${reference.anchor}`;
const problem = (
  code: GeometryProblem["code"],
  elementIds: string[],
  message: string,
): GeometryProblem => ({ code, elementIds, message });

export function validateScene(scene: GeometryScene): GeometryProblem[] {
  const problems: GeometryProblem[] = [];
  const entries = [...scene.walls, ...scene.junctions, ...scene.dimensions];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id))
      problems.push(
        problem(
          "duplicate-id",
          [entry.id],
          "Идентификатор используется несколько раз",
        ),
      );
    ids.add(entry.id);
  }
  if (
    scene.walls.some((w) => !wallSchema.safeParse(w).success) ||
    scene.junctions.some((j) => !junctionSchema.safeParse(j).success) ||
    scene.dimensions.some((d) => !dimensionSchema.safeParse(d).success)
  )
    return [
      ...problems,
      problem(
        "invalid-model",
        [],
        "Некорректные параметры геометрической модели",
      ),
    ];
  const usedEndpoints = new Set<string>();
  for (const junction of scene.junctions) {
    let position: Point | undefined;
    for (const reference of junction.endpoints) {
      const key = refKey(reference);
      if (usedEndpoints.has(key))
        problems.push(
          problem(
            "duplicate-endpoint",
            [junction.id, reference.elementId],
            "Конец стены включён в несколько связей",
          ),
        );
      usedEndpoints.add(key);
      const resolved = resolveReference(
        reference,
        scene.walls,
        junction.floorId,
      );
      if (!resolved.ok) {
        problems.push(
          problem(
            resolved.code === "duplicate-element"
              ? "duplicate-id"
              : resolved.code,
            [junction.id, ...resolved.elementIds],
            "Связь с концом стены недоступна",
          ),
        );
        continue;
      }
      if (position && distance(position, resolved.point) > GEOMETRY_EPSILON)
        problems.push(
          problem(
            "disconnected-junction",
            [junction.id, reference.elementId],
            "Связанные концы стен имеют разные координаты",
          ),
        );
      position ??= resolved.point;
    }
  }
  for (const wall of scene.walls) {
    if (distance(wall.start, wall.end) === 0)
      problems.push(
        problem("degenerate-wall", [wall.id], "Стена имеет нулевую длину"),
      );
    if (
      wall.measuredLength !== null &&
      !lengthMatches(wall, wall.measuredLength)
    )
      problems.push(
        problem(
          "measured-length-conflict",
          [wall.id],
          "Геометрия стены не соответствует заданному размеру",
        ),
      );
  }
  for (const dimension of scene.dimensions) {
    const evaluated = evaluateDimension(dimension, scene.walls);
    if (!evaluated.ok) {
      problems.push(
        problem(
          evaluated.code === "duplicate-element"
            ? "duplicate-id"
            : evaluated.code,
          [dimension.id, ...evaluated.elementIds],
          "Размер потерял связь с элементом",
        ),
      );
      continue;
    }
    if (dimension.mode === "driving") {
      if (
        dimension.from.elementId !== dimension.to.elementId ||
        dimension.from.anchor === "center" ||
        dimension.to.anchor === "center" ||
        dimension.from.anchor === dimension.to.anchor
      ) {
        problems.push(
          problem(
            "unsupported-driving-dimension",
            [dimension.id],
            "В этой фазе управляющий размер задаёт длину одной стены",
          ),
        );
        continue;
      }
      const wall = scene.walls.find((w) => w.id === dimension.from.elementId)!;
      if (
        dimension.inputValue !== null &&
        !lengthMatches(wall, dimension.inputValue)
      )
        problems.push(
          problem(
            "dimension-conflict",
            [dimension.id, wall.id],
            "Управляющий размер противоречит геометрии",
          ),
        );
    }
  }
  return problems;
}
function unsafeProblems(scene: GeometryScene): GeometryProblem[] {
  return validateScene(scene).filter((p) =>
    ["invalid-model", "duplicate-id", "duplicate-endpoint"].includes(p.code),
  );
}
function result(
  before: GeometryScene,
  scene: GeometryScene,
  changedWallIds: string[] = [],
  changedDimensionIds: string[] = [],
): GeometryCommandResult {
  const unsafe = unsafeProblems(before);
  if (unsafe.length) return { ok: false, problems: unsafe };
  const fingerprint = (p: GeometryProblem) =>
    JSON.stringify([p.code, [...p.elementIds].sort()]);
  const existing = new Set(validateScene(before).map(fingerprint));
  const problems = validateScene(scene);
  const affected = new Set([...changedWallIds, ...changedDimensionIds]);
  const protectedCodes = new Set([
    "measured-length-conflict",
    "dimension-conflict",
    "degenerate-wall",
  ]);
  const introduced = problems.filter(
    (p) =>
      !existing.has(fingerprint(p)) ||
      (protectedCodes.has(p.code) &&
        p.elementIds.some((id) => affected.has(id))),
  );
  // Existing issues remain visible but do not block unrelated edits.
  return introduced.length
    ? { ok: false, problems: introduced }
    : {
        ok: true,
        scene,
        problems,
        changedWallIds: changedWallIds.sort(),
        changedDimensionIds: changedDimensionIds.sort(),
      };
}
// A junction carries references only. Coordinates are updated atomically on walls.
function replaceConnectedWall(
  scene: GeometryScene,
  replacement: Wall,
  dimensions = scene.dimensions,
  changedDimensionIds: string[] = [],
): GeometryCommandResult {
  const initialProblems = unsafeProblems(scene);
  if (initialProblems.length) return { ok: false, problems: initialProblems };
  const source = scene.walls.find((w) => w.id === replacement.id);
  if (!source)
    return {
      ok: false,
      problems: [
        problem("missing-element", [replacement.id], "Стена не найдена"),
      ],
    };
  const targets = new Map<string, Point>();
  for (const anchor of ["start", "end"] as const) {
    // Propagate even sub-epsilon edits; tolerance is never used to discard user input.
    if (
      source[anchor].x === replacement[anchor].x &&
      source[anchor].y === replacement[anchor].y
    )
      continue;
    targets.set(refKey({ elementId: source.id, anchor }), replacement[anchor]);
    const junction = scene.junctions.find((j) =>
      j.endpoints.some((r) => r.elementId === source.id && r.anchor === anchor),
    );
    if (junction)
      for (const reference of junction.endpoints)
        targets.set(refKey(reference), replacement[anchor]);
  }
  const changedWallIds: string[] = [];
  const walls = scene.walls.map((wall) => {
    const candidate = wall.id === replacement.id ? replacement : wall;
    const start = targets.get(refKey({ elementId: wall.id, anchor: "start" }));
    const end = targets.get(refKey({ elementId: wall.id, anchor: "end" }));
    if (
      !start &&
      !end &&
      candidate.measuredLength === wall.measuredLength &&
      candidate.start.x === wall.start.x &&
      candidate.start.y === wall.start.y &&
      candidate.end.x === wall.end.x &&
      candidate.end.y === wall.end.y
    )
      return wall;
    changedWallIds.push(wall.id);
    return {
      ...candidate,
      start: start ? { ...start } : candidate.start,
      end: end ? { ...end } : candidate.end,
    };
  });
  // Reject the whole edit if it breaks another measured length or driving dimension.
  return result(
    scene,
    { ...scene, walls, dimensions },
    changedWallIds,
    changedDimensionIds,
  );
}
export function translateSceneWall(
  scene: GeometryScene,
  wallId: string,
  offset: Point,
): GeometryCommandResult {
  assertPoint(offset);
  const wall = scene.walls.find((w) => w.id === wallId);
  if (!wall)
    return {
      ok: false,
      problems: [problem("missing-element", [wallId], "Стена не найдена")],
    };
  return replaceConnectedWall(scene, translateWall(wall, offset));
}
export function rotateSceneWall(
  scene: GeometryScene,
  wallId: string,
  angle: number,
  pivot?: Point,
): GeometryCommandResult {
  const wall = scene.walls.find((w) => w.id === wallId);
  if (!wall)
    return {
      ok: false,
      problems: [problem("missing-element", [wallId], "Стена не найдена")],
    };
  return replaceConnectedWall(scene, rotateWall(wall, angle, pivot));
}
export function applyDrivingDimension(
  scene: GeometryScene,
  dimensionId: string,
  length: number,
): GeometryCommandResult {
  assertPositive(length, "Длина");
  const dimension = scene.dimensions.find((d) => d.id === dimensionId);
  if (!dimension)
    return {
      ok: false,
      problems: [problem("missing-element", [dimensionId], "Размер не найден")],
    };
  const initialProblems = unsafeProblems(scene);
  if (initialProblems.length) return { ok: false, problems: initialProblems };
  const evaluated = evaluateDimension(dimension, scene.walls);
  if (!evaluated.ok)
    return {
      ok: false,
      problems: [
        problem(
          evaluated.code === "duplicate-element"
            ? "duplicate-id"
            : evaluated.code,
          [dimension.id, ...evaluated.elementIds],
          "Размер потерял связь с элементом",
        ),
      ],
    };
  if (
    dimension.mode !== "driving" ||
    dimension.from.elementId !== dimension.to.elementId ||
    dimension.from.anchor === "center" ||
    dimension.to.anchor === "center" ||
    dimension.from.anchor === dimension.to.anchor
  )
    return {
      ok: false,
      problems: [
        problem(
          "unsupported-driving-dimension",
          [dimension.id],
          "Справочный размер не управляет геометрией",
        ),
      ],
    };
  const wall = scene.walls.find((w) => w.id === dimension.from.elementId)!;
  const replacement = setWallLength(
    wall,
    length,
    dimension.from.anchor as "start" | "end",
  );
  const dimensions = scene.dimensions.map((d) =>
    d.id === dimension.id ? { ...d, inputValue: length } : d,
  );
  return replaceConnectedWall(
    scene,
    replacement,
    dimensions,
    dimension.inputValue === length ? [] : [dimension.id],
  );
}
export function connectEndpoints(
  scene: GeometryScene,
  junction: Junction,
): GeometryCommandResult {
  // Explicit connection accepts already coincident endpoints; it never closes a gap silently.
  return result(scene, { ...scene, junctions: [...scene.junctions, junction] });
}
export function detachEndpoint(
  scene: GeometryScene,
  reference: EndpointReference,
): GeometryCommandResult {
  const initialProblems = unsafeProblems(scene);
  if (initialProblems.length) return { ok: false, problems: initialProblems };
  if (!scene.walls.some((w) => w.id === reference.elementId))
    return {
      ok: false,
      problems: [
        problem("missing-element", [reference.elementId], "Стена не найдена"),
      ],
    };
  const junctions = scene.junctions
    .map((j) => ({
      ...j,
      endpoints: j.endpoints.filter((r) => refKey(r) !== refKey(reference)),
    }))
    .filter((j) => j.endpoints.length >= 2);
  return result(scene, { ...scene, junctions });
}
