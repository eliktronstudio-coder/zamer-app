import {
  evaluateIssues,
  applyRepair,
  focusPoints,
  type PlanIssue,
  type Repair,
} from "../issues/engine";
import {
  CalculationEngine,
  createRoom,
  detectedAt,
  reconcileRooms,
  type CalculationResult,
} from "../calculation/engine";
import { roomSchema, type Room } from "../domain/model";
import type { DetectedRoom } from "../geometry/rooms";
import {
  defaultElement,
  isConstructionTool,
  putElement,
  type ConstructionTool,
} from "./element-commands";
import type { ConstructionElement } from "../domain/model";
import { nearestOnSegment } from "../geometry/segments";
import { distance } from "../geometry/primitives";
import { createStore } from "zustand/vanilla";
import type { EndpointReference, Point } from "../domain/model";
import {
  detachEndpoint,
  type GeometryScene,
  type GeometryCommandResult,
} from "../geometry/constraints";
import { constructWall } from "../geometry/construction";
import { snapPoint } from "../geometry/snapping";
import { parseLengthInput } from "../geometry/walls";
import {
  addWall,
  deleteElement,
  endpointFromSnap,
  updateWallProperties,
} from "./commands";
export type Tool =
  | "select"
  | "wall"
  | "dimension"
  | "hand"
  | "room"
  | "defect"
  | ConstructionTool;
export interface EditorState {
  issues: PlanIssue[];
  focusRequest: { points: Point[]; serial: number } | null;
  showIssue: (issue: PlanIssue) => void;
  repairIssue: (repair: Repair) => void;
  calculation: CalculationResult;
  roomCandidate: DetectedRoom | null;
  rebindRoomId: string | null;
  pickRoom: (point: Point) => void;
  registerRoom: (name: string, height: number | null) => void;
  updateRoom: (room: Room) => void;
  finishRoom: (id: string, withNotes?: boolean) => boolean;
  rebindRoom: (id: string) => void;
  elementDraft: ConstructionElement | null;
  draftDirty: boolean;
  constructionPoints: Point[];
  placeConstruction: (point: Point, scale: number) => void;
  finishBoundary: () => void;
  updateElement: (element: ConstructionElement) => void;
  scene: GeometryScene;
  past: GeometryScene[];
  future: GeometryScene[];
  changeId: number;
  selection: string | null;
  tool: Tool;
  orthogonal: boolean;
  snaps: boolean;
  thickness: number;
  height: number;
  scale: number;
  start: { point: Point; link?: EndpointReference } | null;
  pointer: Point | null;
  lengthInput: string;
  message: string;
  commit: (scene: GeometryScene) => void;
  apply: (result: GeometryCommandResult) => void;
  setTool: (tool: Tool) => void;
  select: (id: string | null) => void;
  setPointer: (point: Point) => void;
  place: (point: Point, scale: number) => void;
  cancel: () => void;
  undo: () => void;
  redo: () => void;
  remove: () => void;
  resize: (id: string, length: number) => void;
  detach: () => void;
}
export function createEditorStore(
  floorId: string,
  scene: GeometryScene,
  height: number,
) {
  const engine = new CalculationEngine();
  scene = reconcileRooms(scene, height);
  return createStore<EditorState>((set, get) => ({
    issues: evaluateIssues({ floorId, scene, height }),
    focusRequest: null,
    showIssue: (issue) => {
      const id = issue.elementIds.find((id) =>
        [
          ...get().scene.walls,
          ...(get().scene.elements ?? []),
          ...get().scene.dimensions,
          ...(get().scene.rooms ?? []),
        ].some((e) => e.id === id),
      );
      get().setTool("select");
      set({
        selection: id ?? null,
        focusRequest: {
          points: focusPoints(get().scene, id, issue.point),
          serial: (get().focusRequest?.serial ?? 0) + 1,
        },
      });
    },
    repairIssue: (repair) => {
      try {
        get().commit(applyRepair(get().scene, repair));
      } catch (error) {
        set({
          message:
            error instanceof Error ? error.message : "Исправление недоступно",
        });
      }
    },
    calculation: engine.evaluate(scene, height),
    roomCandidate: null,
    rebindRoomId: null,
    elementDraft: null,
    draftDirty: false,
    constructionPoints: [],
    scene,
    past: [],
    future: [],
    changeId: 0,
    selection: null,
    tool: "select",
    orthogonal: true,
    snaps: true,
    thickness: 0.2,
    height,
    scale: 80,
    start: null,
    pointer: null,
    lengthInput: "",
    message: "",
    commit: (next) => {
      const state = get();
      next = reconcileRooms(next, height, state.scene);
      if (
        next === state.scene ||
        JSON.stringify(next) === JSON.stringify(state.scene)
      )
        return;
      set({
        scene: next,
        calculation: engine.evaluate(next, height),
        issues: evaluateIssues({ floorId, scene: next, height }),
        past: [...state.past, state.scene].slice(-100),
        future: [],
        changeId: state.changeId + 1,
        message: "",
      });
    },
    apply: (result) => {
      if (result.ok) get().commit(result.scene);
      else set({ message: result.problems.map((p) => p.message).join(". ") });
    },
    setTool: (tool) =>
      set({
        tool,
        start: null,
        pointer: null,
        lengthInput: "",
        message: "",
        constructionPoints: [],
        roomCandidate: null,
        rebindRoomId: null,
        draftDirty: false,
        elementDraft: isConstructionTool(tool)
          ? defaultElement(tool, floorId, height)
          : null,
      }),
    select: (selection) => set({ selection, message: "" }),
    setPointer: (pointer) => set({ pointer }),
    place: (point, scale) => {
      const state = get();
      try {
        if (!state.start) {
          const snapped = state.snaps
            ? snapPoint({
                pointer: point,
                walls: state.scene.walls,
                floorId,
                pixelsPerMeter: scale,
                tolerancePixels: 10,
                enabledKinds: [
                  "start",
                  "end",
                  "center",
                  "intersection",
                  "nearest",
                ],
              })
            : { point, candidate: null };
          set({
            start: {
              point: snapped.point,
              link: endpointFromSnap(state.scene, snapped.candidate),
            },
            pointer: { x: snapped.point.x + 1, y: snapped.point.y },
            message: "",
          });
          return;
        }
        const length = state.lengthInput.trim()
          ? parseLengthInput(state.lengthInput)
          : null;
        const constructed = constructWall({
          id: crypto.randomUUID(),
          floorId,
          start: state.start.point,
          pointer: point,
          length,
          thickness: state.thickness,
          height: state.height,
          orthogonal: state.orthogonal,
          snapping: state.snaps
            ? {
                walls: state.scene.walls,
                pixelsPerMeter: scale,
                tolerancePixels: 10,
                enabledKinds: [
                  "start",
                  "end",
                  "center",
                  "intersection",
                  "nearest",
                ],
              }
            : undefined,
        });
        const next = addWall(
          state.scene,
          constructed.wall,
          state.start.link,
          endpointFromSnap(state.scene, constructed.snap),
        );
        state.commit(next);
        set({
          start: {
            point: constructed.wall.end,
            link: { elementId: constructed.wall.id, anchor: "end" },
          },
          pointer: constructed.wall.end,
          lengthInput: "",
          selection: constructed.wall.id,
        });
      } catch (error) {
        set({
          message:
            error instanceof Error
              ? error.message
              : "Не удалось построить стену",
        });
      }
    },
    cancel: () =>
      set({
        start: null,
        pointer: null,
        lengthInput: "",
        message: "",
        constructionPoints: [],
        roomCandidate: null,
        rebindRoomId: null,
      }),
    undo: () => {
      const state = get(),
        previous = state.past.at(-1);
      if (!previous) return;
      set({
        scene: previous,
        calculation: engine.evaluate(previous, height),
        issues: evaluateIssues({ floorId, scene: previous, height }),
        roomCandidate: null,
        rebindRoomId: null,
        past: state.past.slice(0, -1),
        future: [state.scene, ...state.future],
        selection: null,
        start: null,
        pointer: null,
        constructionPoints: [],
        changeId: state.changeId + 1,
        message: "",
      });
    },
    redo: () => {
      const state = get(),
        next = state.future[0];
      if (!next) return;
      set({
        scene: next,
        calculation: engine.evaluate(next, height),
        issues: evaluateIssues({ floorId, scene: next, height }),
        past: [...state.past, state.scene].slice(-100),
        future: state.future.slice(1),
        selection: null,
        start: null,
        pointer: null,
        constructionPoints: [],
        changeId: state.changeId + 1,
        message: "",
      });
    },
    remove: () => {
      const state = get();
      if (!state.selection) return;
      state.commit(deleteElement(state.scene, state.selection));
      set({ selection: null, start: null, pointer: null });
    },
    resize: (id, length) => {
      const state = get(),
        wall = state.scene.walls.find((w) => w.id === id);
      if (wall)
        state.apply(
          updateWallProperties(state.scene, id, {
            length,
            thickness: wall.thickness,
            height: wall.height,
          }),
        );
    },
    updateElement: (element) => {
      try {
        if (element.floorId !== floorId) throw new Error("Другой этаж");
        get().commit(putElement(get().scene, element));
      } catch (error) {
        set({
          message: error instanceof Error ? error.message : "Проверьте элемент",
        });
      }
    },
    placeConstruction: (point, scale) => {
      const state = get(),
        draft = state.elementDraft;
      if (!draft) return;
      try {
        if (state.draftDirty)
          throw new Error("Примените параметры перед размещением элемента");
        if (draft.kind === "levelChange") {
          set({
            constructionPoints: [...state.constructionPoints, point],
            message: "",
          });
          return;
        }
        if (draft.kind === "beam" && !state.constructionPoints.length) {
          set({
            constructionPoints: [point],
            pointer: { x: point.x + 1, y: point.y },
            message: "",
          });
          return;
        }
        let element: ConstructionElement;
        if (draft.kind === "opening") {
          const target = state.scene.walls
            .map((w) => ({ w, projection: nearestOnSegment(point, w) }))
            .filter(
              ({ w, projection }) =>
                projection.distance <= w.thickness / 2 + 10 / scale,
            )
            .sort((a, b) => a.projection.distance - b.projection.distance)[0];
          if (!target)
            throw new Error("Нажмите на стену в центре будущего проёма");
          element = {
            ...draft,
            wallId: target.w.id,
            offset:
              distance(target.w.start, target.projection.point) -
              draft.width / 2,
          };
        } else if (draft.kind === "beam") {
          const wall = constructWall({
            id: draft.id,
            floorId,
            start: state.constructionPoints[0],
            pointer: point,
            length: distance(draft.start, draft.end),
            thickness: draft.width,
            height: draft.height,
            orthogonal: state.orthogonal,
          }).wall;
          element = { ...draft, start: wall.start, end: wall.end };
        } else element = { ...draft, position: point };
        element = { ...element, id: crypto.randomUUID() };
        state.commit(putElement(state.scene, element));
        set({ selection: element.id, constructionPoints: [], message: "" });
      } catch (error) {
        set({
          message:
            error instanceof Error ? error.message : "Проверьте параметры",
        });
      }
    },
    finishBoundary: () => {
      const state = get();
      if (state.elementDraft?.kind !== "levelChange") return;
      try {
        if (state.draftDirty)
          throw new Error("Примените параметры перед завершением границы");
        const element = {
          ...state.elementDraft,
          id: crypto.randomUUID(),
          boundary: state.constructionPoints,
        };
        state.commit(putElement(state.scene, element));
        set({ selection: element.id, constructionPoints: [], message: "" });
      } catch (error) {
        set({
          message: error instanceof Error ? error.message : "Проверьте контур",
        });
      }
    },
    pickRoom: (point) => {
      const state = get(),
        face = detectedAt(state.calculation.topology, point);
      if (!face) {
        set({
          message:
            "Нажмите внутри замкнутого контура. Проверьте разрывы и пересечения стен.",
          roomCandidate: null,
        });
        return;
      }
      const existing = state.scene.rooms?.find(
        (r) => r.sourceKey === face.sourceKey && r.geometricallyClosed,
      );
      if (existing) {
        if (state.rebindRoomId && state.rebindRoomId !== existing.id) {
          set({ message: "Этот контур уже принадлежит другому помещению" });
          return;
        }
        set({
          selection: existing.id,
          roomCandidate: null,
          tool: "select",
          rebindRoomId: null,
          message: "",
        });
        return;
      }
      set({ roomCandidate: face, message: "" });
    },
    registerRoom: (name, roomHeight) => {
      const state = get();
      if (!state.roomCandidate) return;
      try {
        const old = state.scene.rooms?.find((r) => r.id === state.rebindRoomId);
        const room = roomSchema.parse(
          old
            ? {
                ...old,
                ...state.roomCandidate,
                geometricallyClosed: true,
                status: "inProgress",
              }
            : { ...createRoom(state.roomCandidate, name, roomHeight) },
        );
        state.commit({
          ...state.scene,
          rooms: old
            ? (state.scene.rooms ?? []).map((r) => (r.id === old.id ? room : r))
            : [...(state.scene.rooms ?? []), room],
        });
        set({
          selection: room.id,
          tool: "select",
          roomCandidate: null,
          rebindRoomId: null,
          message: "",
        });
      } catch (error) {
        set({
          message:
            error instanceof Error ? error.message : "Проверьте помещение",
        });
      }
    },
    updateRoom: (room) => {
      try {
        const parsed = roomSchema.parse(room);
        if (parsed.floorId !== floorId) throw new Error("Другой этаж");
        get().commit({
          ...get().scene,
          rooms: (get().scene.rooms ?? []).map((r) =>
            r.id === room.id ? parsed : r,
          ),
        });
      } catch (error) {
        set({
          message:
            error instanceof Error ? error.message : "Проверьте помещение",
        });
      }
    },
    finishRoom: (id, withNotes = false) => {
      const state = get(),
        room = state.scene.rooms?.find((r) => r.id === id),
        q = state.calculation.rooms.find((r) => r.roomId === id);
      if (!room || !q) return false;
      const complete =
        q.complete &&
        !state.issues.some(
          (issue) =>
            issue.severity !== "info" &&
            (issue.roomIds.includes(id) || issue.ruleId === "rule-failed"),
        );
      if (!complete && !withNotes) return false;
      state.updateRoom({
        ...room,
        status: complete ? "completed" : "completedWithNotes",
      });
      return true;
    },
    rebindRoom: (id) => {
      get().setTool("room");
      set({
        rebindRoomId: id,
        message: "Укажите новый замкнутый контур для помещения",
      });
    },
    detach: () => {
      const state = get();
      if (!state.selection) return;
      const first = detachEndpoint(state.scene, {
        elementId: state.selection,
        anchor: "start",
      });
      if (!first.ok) {
        state.apply(first);
        return;
      }
      state.apply(
        detachEndpoint(first.scene, {
          elementId: state.selection,
          anchor: "end",
        }),
      );
    },
  }));
}
export type EditorStore = ReturnType<typeof createEditorStore>;
