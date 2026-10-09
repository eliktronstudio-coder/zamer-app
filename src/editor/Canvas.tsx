import { boundsOverlap, pointBounds } from "../geometry/bounds";
import { DefectLayer } from "../features/media/DefectLayer";
import { RoomLayer } from "./RoomLayer";
import { pointInRoom } from "../geometry/rooms";
import { ConstructionLayer } from "./ConstructionLayer";
import { elementHit, elementPoints } from "../geometry/elements";
import { isConstructionTool, moveElement } from "./element-commands";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { Stage, Layer, Line, Circle, Rect, Text, Group } from "react-konva";
import { useStore } from "zustand";
import type { EditorStore } from "./store";
import type { Point } from "../domain/model";
import { constructWall } from "../geometry/construction";
import {
  translateSceneWall,
  type GeometryScene,
} from "../geometry/constraints";
import { distance } from "../geometry/primitives";
import { nearestOnSegment } from "../geometry/segments";
import { evaluateDimension } from "../geometry/dimensions";
import { parseLengthInput } from "../geometry/walls";
import { formatLength } from "../app/format";
import { addReferenceDimension, dimensionLayout } from "./commands";
import {
  screenToWorld,
  worldToScreen,
  zoomAt,
  type Viewport,
} from "./viewport";
interface Gesture {
  mode: "pan" | "pick" | "move";
  start: Point;
  viewport: Viewport;
  scene: GeometryScene;
  wallId?: string;
  moved: boolean;
  preview?: GeometryScene;
  error?: string;
}
export function Canvas({
  store,
  floorId,
  onDefectPoint,
}: {
  store: EditorStore;
  floorId: string;
  onDefectPoint: (point: Point) => void;
}) {
  const state = useStore(store);
  const [defectCount, setDefectCount] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 300, height: 480 });
  const [viewport, setViewport] = useState<Viewport>({
    x: 48,
    y: 72,
    scale: 80,
  });
  const viewportRef = useRef(viewport);
  const [dragScene, setDragScene] = useState<GeometryScene | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{
    distance: number;
    center: Point;
    viewport: Viewport;
  } | null>(null);
  const wasPinch = useRef(false);
  const lastPlacement = useRef<{ point: Point; time: number } | null>(null);
  const updateViewport = useCallback(
    (v: Viewport) => {
      viewportRef.current = v;
      setViewport(v);
      store.setState({ scale: v.scale });
    },
    [store],
  );
  useEffect(() => {
    const request = state.focusRequest;
    if (!request || !request.points.length) return;
    const xs = request.points.map((p) => p.x),
      ys = request.points.map((p) => p.y);
    const minX = Math.min(...xs),
      maxX = Math.max(...xs),
      minY = Math.min(...ys),
      maxY = Math.max(...ys);
    const scale = Math.max(
      15,
      Math.min(
        80,
        size.width / (maxX - minX + 1),
        size.height / (maxY - minY + 1),
      ),
    );
    const frame = requestAnimationFrame(() => {
      updateViewport({
        scale,
        x: size.width / 2 - ((minX + maxX) / 2) * scale,
        y: size.height / 2 - ((minY + maxY) / 2) * scale,
      });
      container.current?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [state.focusRequest, size.width, size.height, updateViewport]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setSize({
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = element.getBoundingClientRect(),
        point = {
          x: event.clientX - bounds.left - element.clientLeft,
          y: event.clientY - bounds.top - element.clientTop,
        };
      const current = viewportRef.current;
      updateViewport(
        zoomAt(
          current,
          point,
          current.scale * Math.exp(-event.deltaY * 0.0015),
        ),
      );
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [updateViewport]);
  const position = (event: PointerEvent<HTMLDivElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - rect.left - event.currentTarget.clientLeft,
      y: event.clientY - rect.top - event.currentTarget.clientTop,
    };
  };
  function hit(
    screen: Point,
    scene: GeometryScene,
    v: Viewport,
    dimensions = true,
  ): {
    id: string;
    kind: "wall" | "dimension" | "construction" | "room";
  } | null {
    if (dimensions)
      for (const dimension of [...scene.dimensions].reverse()) {
        const evaluated = evaluateDimension(dimension, scene.walls);
        if (!evaluated.ok) continue;
        const center = worldToScreen(
          dimensionLayout(evaluated.from, evaluated.to, dimension.offset)
            .center,
          v,
        );
        const vertical =
          Math.abs(evaluated.to.y - evaluated.from.y) >
          Math.abs(evaluated.to.x - evaluated.from.x);
        if (
          Math.abs(screen.x - center.x) <= (vertical ? 14 : 46) &&
          Math.abs(screen.y - center.y) <= (vertical ? 46 : 14)
        )
          return { id: dimension.id, kind: "dimension" };
      }
    const world = screenToWorld(screen, v);
    if (dimensions)
      for (const e of [...(scene.elements ?? [])].reverse())
        if (elementHit(e, world, scene.walls, 8 / v.scale))
          return { id: e.id, kind: "construction" };
    const closest = scene.walls
      .map((w) => ({ wall: w, distance: nearestOnSegment(world, w).distance }))
      .filter((c) => c.distance <= c.wall.thickness / 2 + 8 / v.scale)
      .sort((a, b) => a.distance - b.distance)[0];
    if (closest) return { id: closest.wall.id, kind: "wall" };
    if (dimensions) {
      const room = scene.rooms?.find(
        (r) => r.geometricallyClosed && pointInRoom(world, r),
      );
      if (room) return { id: room.id, kind: "room" };
    }
    return null;
  }
  function down(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = position(event);
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        distance: distance(a, b),
        center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        viewport: viewportRef.current,
      };
      wasPinch.current = true;
      gesture.current = null;
      setDragScene(null);
      return;
    }
    const current = store.getState(),
      v = viewportRef.current,
      target = hit(point, current.scene, v);
    const moving =
      event.button === 0 &&
      current.tool === "select" &&
      (target?.kind === "wall" || target?.kind === "construction") &&
      target.id === current.selection;
    if (current.tool === "select" && event.button === 0)
      current.select(target?.id ?? null);
    gesture.current = {
      mode: moving
        ? "move"
        : current.tool === "select" &&
            target &&
            target.kind !== "room" &&
            event.button === 0
          ? "pick"
          : "pan",
      start: point,
      viewport: v,
      scene: current.scene,
      wallId: moving ? target.id : undefined,
      moved: false,
    };
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const point = position(event);
    if (pointers.current.has(event.pointerId))
      pointers.current.set(event.pointerId, point);
    if (wasPinch.current) {
      const initial = pinch.current;
      if (!initial || pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()],
        center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (initial.distance < 1) return;
      const zoomed = zoomAt(
        initial.viewport,
        initial.center,
        (initial.viewport.scale * distance(a, b)) / initial.distance,
      );
      updateViewport({
        ...zoomed,
        x: zoomed.x + center.x - initial.center.x,
        y: zoomed.y + center.y - initial.center.y,
      });
      return;
    }
    const active = gesture.current;
    if (active && pointers.current.has(event.pointerId)) {
      if (distance(point, active.start) >= 5) active.moved = true;
      if (active.moved && active.mode === "pan") {
        updateViewport({
          ...active.viewport,
          x: active.viewport.x + point.x - active.start.x,
          y: active.viewport.y + point.y - active.start.y,
        });
        return;
      }
      if (active.moved && active.mode === "move" && active.wallId) {
        const from = screenToWorld(active.start, active.viewport),
          to = screenToWorld(point, active.viewport);
        const delta = { x: to.x - from.x, y: to.y - from.y };
        if (active.scene.elements?.some((e) => e.id === active.wallId)) {
          try {
            active.preview = moveElement(active.scene, active.wallId, delta);
            active.error = undefined;
          } catch (error) {
            active.preview = undefined;
            active.error =
              error instanceof Error
                ? error.message
                : "Нельзя переместить элемент";
          }
          setDragScene(active.preview ?? null);
          return;
        }
        const result = translateSceneWall(active.scene, active.wallId, delta);
        active.preview = result.ok ? result.scene : undefined;
        active.error = result.ok
          ? undefined
          : result.problems.map((p) => p.message).join(". ");
        setDragScene(active.preview ?? null);
        return;
      }
    }
    if (
      store.getState().tool === "wall" ||
      isConstructionTool(store.getState().tool)
    )
      store.getState().setPointer(screenToWorld(point, viewportRef.current));
  }
  function up(event: PointerEvent<HTMLDivElement>) {
    const point = position(event);
    pointers.current.delete(event.pointerId);
    if (wasPinch.current) {
      if (!pointers.current.size) {
        wasPinch.current = false;
        pinch.current = null;
      }
      return;
    }
    const active = gesture.current;
    gesture.current = null;
    setDragScene(null);
    if (!active) return;
    const current = store.getState();
    if (active.mode === "move" && active.moved) {
      if (active.preview) current.commit(active.preview);
      else if (active.error) store.setState({ message: active.error });
      return;
    }
    if (active.moved || event.button === 1) return;
    const world = screenToWorld(point, viewportRef.current);
    if (current.tool === "defect") onDefectPoint(world);
    if (current.tool === "room") current.pickRoom(world);
    if (current.tool === "wall" || isConstructionTool(current.tool)) {
      const last = lastPlacement.current;
      if (
        last &&
        event.timeStamp - last.time < 300 &&
        distance(last.point, point) < 5
      )
        return;
      lastPlacement.current = { point, time: event.timeStamp };
      if (current.tool === "wall")
        current.place(world, viewportRef.current.scale);
      else current.placeConstruction(world, viewportRef.current.scale);
    }
    if (current.tool === "dimension") {
      const target = hit(point, current.scene, viewportRef.current, false),
        wall = current.scene.walls.find((w) => w.id === target?.id);
      if (wall) {
        const next = addReferenceDimension(current.scene, wall);
        current.commit(next);
        current.select(next.dimensions.at(-1)!.id);
      } else
        store.setState({
          message: "Нажмите на стену, чтобы добавить справочный размер.",
        });
    }
  }
  function cancel(event: PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    gesture.current = null;
    setDragScene(null);
    if (!pointers.current.size) {
      pinch.current = null;
      wasPinch.current = false;
    }
  }
  const scene = dragScene ?? state.scene;
  let draft: ReturnType<typeof constructWall> | null = null;
  if (state.tool === "wall" && state.start && state.pointer) {
    try {
      draft = constructWall({
        id: "00000000-0000-4000-8000-000000000001",
        floorId,
        start: state.start.point,
        pointer: state.pointer,
        length: state.lengthInput.trim()
          ? parseLengthInput(state.lengthInput)
          : null,
        thickness: state.thickness,
        height: state.height,
        orthogonal: state.orthogonal,
        snapping: state.snaps
          ? {
              walls: scene.walls,
              pixelsPerMeter: viewport.scale,
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
    } catch {
      /* An incomplete numeric input is kept until the user submits it. */
    }
  }
  const min = screenToWorld({ x: 0, y: 0 }, viewport),
    max = screenToWorld({ x: size.width, y: size.height }, viewport);
  const bounds = { minX: min.x, minY: min.y, maxX: max.x, maxY: max.y };
  const visibleWalls = scene.walls.filter((w) =>
    boundsOverlap(
      bounds,
      pointBounds([w.start, w.end], w.thickness / 2 + 16 / viewport.scale)!,
    ),
  );
  const step = viewport.scale < 40 ? 1 : 0.5;
  const grid = [];
  const firstX = Math.floor(min.x / step) * step,
    firstY = Math.floor(min.y / step) * step;
  for (
    let i = 0;
    i < Math.ceil(size.width / (viewport.scale * step)) + 2;
    i++
  ) {
    const x = firstX + i * step;
    grid.push(
      <Line
        key={`x${i}`}
        points={[x, min.y, x, max.y]}
        stroke="#e8eeeb"
        strokeWidth={1 / viewport.scale}
      />,
    );
  }
  for (
    let i = 0;
    i < Math.ceil(size.height / (viewport.scale * step)) + 2;
    i++
  ) {
    const y = firstY + i * step;
    grid.push(
      <Line
        key={`y${i}`}
        points={[min.x, y, max.x, y]}
        stroke="#e8eeeb"
        strokeWidth={1 / viewport.scale}
      />,
    );
  }
  function fit() {
    if (!scene.walls.length && !scene.elements?.length) {
      updateViewport({ x: 48, y: 72, scale: 80 });
      return;
    }
    const points = [
        ...scene.walls.flatMap((w) => [w.start, w.end]),
        ...(scene.elements ?? []).flatMap((e) => elementPoints(e, scene.walls)),
      ],
      xs = points.map((p) => p.x),
      ys = points.map((p) => p.y),
      left = Math.min(...xs),
      right = Math.max(...xs),
      top = Math.min(...ys),
      bottom = Math.max(...ys);
    const scale = Math.max(
      15,
      Math.min(
        150,
        (size.width - 100) / Math.max(1, right - left),
        (size.height - 100) / Math.max(1, bottom - top),
      ),
    );
    updateViewport({
      scale,
      x: size.width / 2 - ((left + right) / 2) * scale,
      y: size.height / 2 - ((top + bottom) / 2) * scale,
    });
  }
  return (
    <div className="canvas-pane">
      <div
        className={`canvas-surface tool-${state.tool}`}
        ref={container}
        role="application"
        tabIndex={0}
        aria-label={
          state.scene.walls.length ||
          state.scene.elements?.length ||
          defectCount
            ? "Редактор плана"
            : "Пустой план"
        }
        aria-describedby="canvas-instruction"
        data-testid="plan-canvas"
        data-rendered-wall-count={visibleWalls.length}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
      >
        <Stage
          width={size.width}
          height={size.height}
          x={viewport.x}
          y={viewport.y}
          scaleX={viewport.scale}
          scaleY={viewport.scale}
        >
          <Layer listening={false}>
            {grid}
            <RoomLayer
              scene={state.scene}
              result={state.calculation}
              bounds={bounds}
              selection={state.selection}
              scale={viewport.scale}
            />
          </Layer>
          <Layer listening={false}>
            {visibleWalls.map((w) => (
              <Group key={w.id}>
                <Line
                  points={[w.start.x, w.start.y, w.end.x, w.end.y]}
                  stroke={w.id === state.selection ? "#17665b" : "#344c43"}
                  strokeWidth={w.thickness}
                  lineCap="butt"
                />
                {w.id === state.selection &&
                  [w.start, w.end].map((p, i) => (
                    <Circle
                      key={i}
                      x={p.x}
                      y={p.y}
                      radius={5 / viewport.scale}
                      fill="white"
                      stroke="#17665b"
                      strokeWidth={2 / viewport.scale}
                    />
                  ))}
              </Group>
            ))}
          </Layer>
          <Layer listening={false}>
            <ConstructionLayer
              scene={scene}
              bounds={bounds}
              selection={state.selection}
              scale={viewport.scale}
            />
          </Layer>
          <Layer listening={false}>
            {scene.dimensions.map((d) => {
              const result = evaluateDimension(d, scene.walls);
              if (!result.ok) return null;
              const layout = dimensionLayout(result.from, result.to, d.offset),
                color = d.id === state.selection ? "#17665b" : "#687c73";
              if (
                !boundsOverlap(
                  bounds,
                  pointBounds(
                    [result.from, result.to, layout.a, layout.b],
                    60 / viewport.scale,
                  )!,
                )
              )
                return null;
              return (
                <Group key={d.id}>
                  <Line
                    points={[
                      result.from.x,
                      result.from.y,
                      layout.a.x,
                      layout.a.y,
                    ]}
                    stroke={color}
                    strokeWidth={1 / viewport.scale}
                  />
                  <Line
                    points={[result.to.x, result.to.y, layout.b.x, layout.b.y]}
                    stroke={color}
                    strokeWidth={1 / viewport.scale}
                  />
                  <Line
                    points={[layout.a.x, layout.a.y, layout.b.x, layout.b.y]}
                    stroke={color}
                    strokeWidth={1 / viewport.scale}
                  />
                  {[layout.a, layout.b].map((p, i) => (
                    <Circle
                      key={i}
                      x={p.x}
                      y={p.y}
                      radius={2 / viewport.scale}
                      fill={color}
                    />
                  ))}
                  <Group
                    x={layout.center.x}
                    y={layout.center.y}
                    rotation={
                      Math.abs(result.to.y - result.from.y) >
                      Math.abs(result.to.x - result.from.x)
                        ? -90
                        : 0
                    }
                  >
                    <Rect
                      x={-44 / viewport.scale}
                      y={-12 / viewport.scale}
                      width={88 / viewport.scale}
                      height={24 / viewport.scale}
                      cornerRadius={4 / viewport.scale}
                      fill={d.id === state.selection ? "#e2f1ea" : "white"}
                    />
                    <Text
                      x={-44 / viewport.scale}
                      y={-7 / viewport.scale}
                      width={88 / viewport.scale}
                      text={formatLength(result.value)}
                      fontSize={13 / viewport.scale}
                      align="center"
                      fill={color}
                    />
                  </Group>
                </Group>
              );
            })}
          </Layer>
          <Layer listening={false}>
            {state.constructionPoints.length > 0 && (
              <Group>
                <Line
                  points={state.constructionPoints.flatMap((p) => [p.x, p.y])}
                  stroke="#299d81"
                  strokeWidth={2 / viewport.scale}
                  dash={[6 / viewport.scale, 4 / viewport.scale]}
                />
                {state.constructionPoints.map((p, i) => (
                  <Circle
                    key={i}
                    x={p.x}
                    y={p.y}
                    radius={4 / viewport.scale}
                    fill="#17665b"
                  />
                ))}
              </Group>
            )}
            {state.start && (
              <Circle
                x={state.start.point.x}
                y={state.start.point.y}
                radius={5 / viewport.scale}
                fill="#17665b"
              />
            )}
            {draft && (
              <Line
                points={[
                  draft.wall.start.x,
                  draft.wall.start.y,
                  draft.wall.end.x,
                  draft.wall.end.y,
                ]}
                stroke="#299d81"
                strokeWidth={draft.wall.thickness}
                opacity={0.6}
                dash={[8 / viewport.scale, 4 / viewport.scale]}
              />
            )}
            {draft?.snap && (
              <Rect
                x={draft.snap.point.x - 5 / viewport.scale}
                y={draft.snap.point.y - 5 / viewport.scale}
                width={10 / viewport.scale}
                height={10 / viewport.scale}
                stroke="#17665b"
                strokeWidth={2 / viewport.scale}
                fill="white"
              />
            )}
          </Layer>
          <Layer listening={false}>
            <DefectLayer
              floorId={floorId}
              bounds={bounds}
              scale={viewport.scale}
              onCount={setDefectCount}
            />
          </Layer>
        </Stage>
        {!defectCount &&
          !scene.walls.length &&
          !scene.elements?.length &&
          !state.start &&
          !state.constructionPoints.length && (
            <div className="canvas-empty">
              <strong>Пустой рабочий лист</strong>
              <span>Выберите «Стена» и укажите начальную точку.</span>
            </div>
          )}
      </div>
      <div className="viewport-controls">
        <button
          aria-label="Уменьшить масштаб"
          onClick={() =>
            updateViewport(
              zoomAt(
                viewport,
                { x: size.width / 2, y: size.height / 2 },
                viewport.scale / 1.25,
              ),
            )
          }
        >
          −
        </button>
        <output aria-label="Масштаб">
          {Math.round((viewport.scale / 80) * 100)}%
        </output>
        <button
          aria-label="Увеличить масштаб"
          onClick={() =>
            updateViewport(
              zoomAt(
                viewport,
                { x: size.width / 2, y: size.height / 2 },
                viewport.scale * 1.25,
              ),
            )
          }
        >
          +
        </button>
        <button onClick={fit}>Показать весь план</button>
      </div>
      <p id="canvas-instruction" className="canvas-caption">
        {state.tool === "defect"
          ? "Нажмите точку дефекта на плане, затем заполните его свойства."
          : state.tool === "room"
            ? "Нажмите внутри замкнутого контура, чтобы добавить помещение."
            : isConstructionTool(state.tool)
              ? "Задайте параметры конструкции. Esc отменяет незавершённое размещение."
              : state.tool === "wall"
                ? "Укажите начало и направление. Введите точную длину → Enter. Esc завершает цепочку."
                : state.tool === "dimension"
                  ? "Нажмите стену для справочного размера."
                  : "Нажмите элемент для выбора. Перетаскивайте выбранную стену или перемещайте пустой лист."}
      </p>
    </div>
  );
}
