import { useMemo } from "react";
import { boundsOverlap, pointBounds, type Bounds } from "../geometry/bounds";
import { elementPoints } from "../geometry/elements";
import { Group, Line, Shape, Arrow, Text, Arc, Circle } from "react-konva";
import type { ColumnSection, Point } from "../domain/model";
import type { GeometryScene } from "../geometry/constraints";
import {
  sectionContours,
  rectangle,
  openingSegment,
  openingProblems,
} from "../geometry/elements";
const flat = (points: Point[]) => points.flatMap((p) => [p.x, p.y]);
function SectionShape({
  section,
  color,
  scale,
}: {
  section: ColumnSection;
  color: string;
  scale: number;
}) {
  if (section.kind === "composite")
    return (
      <>
        {section.parts.map((part, i) => (
          <Group
            key={i}
            x={part.position.x}
            y={part.position.y}
            rotation={part.rotation}
          >
            <SectionShape section={part.section} color={color} scale={scale} />
          </Group>
        ))}
      </>
    );
  const contours = sectionContours(section);
  return (
    <Shape
      fill={color}
      fillRule="evenodd"
      stroke="#17665b"
      strokeWidth={1.5 / scale}
      sceneFunc={(context, shape) => {
        context.beginPath();
        for (const points of contours) {
          context.moveTo(points[0].x, points[0].y);
          for (const p of points.slice(1)) context.lineTo(p.x, p.y);
          context.closePath();
        }
        context.fillStrokeShape(shape);
      }}
    />
  );
}
export function ConstructionLayer({
  scene,
  selection,
  scale,
  bounds,
}: {
  scene: GeometryScene;
  selection: string | null;
  scale: number;
  bounds: Bounds;
}) {
  const boxes = useMemo(
    () =>
      new Map(
        (scene.elements ?? []).map((e) => [
          e.id,
          pointBounds(
            elementPoints(e, scene.walls),
            e.kind === "opening"
              ? (scene.walls.find((w) => w.id === e.wallId)?.thickness ?? 0) / 2
              : 0,
          ),
        ]),
      ),
    [scene.elements, scene.walls],
  );
  return (
    <>
      {(scene.elements ?? [])
        .filter((e) => {
          const box = boxes.get(e.id);
          return box && boundsOverlap(bounds, box, 120 / scale);
        })
        .map((e) => {
          const color = selection === e.id ? "#17665b" : "#647d73",
            fill = selection === e.id ? "#b9dfd0" : "#dae5df",
            stroke = 1.5 / scale;
          if (e.kind === "column")
            return (
              <Group
                key={e.id}
                x={e.position.x}
                y={e.position.y}
                rotation={e.rotation}
              >
                <SectionShape section={e.section} color={fill} scale={scale} />
              </Group>
            );
          if (e.kind === "opening") {
            const s = openingSegment(e, scene.walls);
            if (!s) return null;
            const errors = openingProblems(e, scene.walls, scene.elements),
              angle =
                (Math.atan2(s.end.y - s.start.y, s.end.x - s.start.x) * 180) /
                Math.PI;
            if (errors.length)
              return (
                <Group key={e.id}>
                  <Line
                    points={flat([s.start, s.end])}
                    stroke="#b94332"
                    strokeWidth={3 / scale}
                    dash={[5 / scale, 4 / scale]}
                  />
                  <Circle
                    x={s.start.x}
                    y={s.start.y}
                    radius={5 / scale}
                    fill="#b94332"
                  />
                </Group>
              );
            return (
              <Group key={e.id} x={s.start.x} y={s.start.y} rotation={angle}>
                <Line
                  points={[0, 0, e.width, 0]}
                  stroke="white"
                  strokeWidth={s.wall.thickness + 2 / scale}
                  lineCap="butt"
                />
                {[0, e.width].map((x) => (
                  <Line
                    key={x}
                    points={[x, -s.wall.thickness / 2, x, s.wall.thickness / 2]}
                    stroke={color}
                    strokeWidth={stroke}
                  />
                ))}
                {e.type === "window" &&
                  [-s.wall.thickness / 4, s.wall.thickness / 4].map((y) => (
                    <Line
                      key={y}
                      points={[0, y, e.width, y]}
                      stroke={color}
                      strokeWidth={stroke}
                    />
                  ))}
                {e.type === "door" && (
                  <Group
                    x={e.side === "right" ? e.width : 0}
                    rotation={e.side === "right" ? 180 : 0}
                  >
                    <Line
                      points={[0, 0, 0, e.width]}
                      stroke={color}
                      strokeWidth={stroke}
                    />
                    <Arc
                      innerRadius={e.width}
                      outerRadius={e.width}
                      angle={90}
                      rotation={0}
                      stroke={color}
                      strokeWidth={stroke}
                    />
                  </Group>
                )}
                {e.type === "void" && (
                  <Line
                    points={[0, 0, e.width, 0]}
                    stroke={color}
                    strokeWidth={1 / scale}
                    dash={[4 / scale, 4 / scale]}
                  />
                )}
              </Group>
            );
          }
          if (e.kind === "beam")
            return (
              <Line
                key={e.id}
                points={flat([e.start, e.end])}
                stroke={color}
                strokeWidth={e.width}
                opacity={0.65}
                dash={[10 / scale, 4 / scale]}
              />
            );
          if (e.kind === "levelChange") {
            const center = e.boundary[0],
              delta = e.toElevation - e.fromElevation;
            return (
              <Group key={e.id}>
                <Line
                  points={flat(e.boundary)}
                  closed={e.boundary.length > 2}
                  stroke={color}
                  strokeWidth={2 / scale}
                  fill={e.boundary.length > 2 ? fill : undefined}
                  opacity={0.6}
                  dash={[7 / scale, 4 / scale]}
                />
                <Text
                  x={center.x}
                  y={center.y - 18 / scale}
                  text={`Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(3)} м`}
                  fontSize={12 / scale}
                  fill={color}
                />
              </Group>
            );
          }
          return (
            <Group
              key={e.id}
              x={e.position.x}
              y={e.position.y}
              rotation={e.rotation}
            >
              <Line
                points={flat(rectangle(e.length, e.width))}
                closed
                fill={fill}
                stroke={color}
                strokeWidth={stroke}
              />
              {e.kind === "stair" &&
                Array.from({ length: e.steps - 1 }, (_, i) => {
                  const x = -e.length / 2 + ((i + 1) * e.length) / e.steps;
                  return (
                    <Line
                      key={i}
                      points={[x, -e.width / 2, x, e.width / 2]}
                      stroke={color}
                      strokeWidth={1 / scale}
                    />
                  );
                })}
              <Arrow
                points={[-e.length * 0.35, 0, e.length * 0.35, 0]}
                stroke={color}
                fill={color}
                strokeWidth={stroke}
                pointerLength={7 / scale}
                pointerWidth={7 / scale}
              />
              {e.kind === "ramp" && (
                <Text
                  x={-e.length / 2}
                  y={e.width / 2 + 4 / scale}
                  text={`${((e.rise / e.length) * 100).toFixed(1)}%`}
                  fontSize={12 / scale}
                  fill={color}
                />
              )}
            </Group>
          );
        })}
    </>
  );
}
