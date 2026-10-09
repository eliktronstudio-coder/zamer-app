import { boundsOverlap, pointBounds, type Bounds } from "../geometry/bounds";
import { Group, Shape, Text } from "react-konva";
import type { GeometryScene } from "../geometry/constraints";
import type { CalculationResult } from "../calculation/engine";
import { roomLabelPoint } from "../geometry/rooms";
import { polygonArea } from "../geometry/primitives";
import { quantity } from "./RoomProperties";
export function RoomLayer({
  scene,
  result,
  selection,
  scale,
  bounds,
}: {
  scene: GeometryScene;
  result: CalculationResult;
  selection: string | null;
  scale: number;
  bounds: Bounds;
}) {
  return (
    <>
      {result.topology.candidates
        .filter((face) => {
          const box = pointBounds(face.boundary, 120 / scale);
          return box && boundsOverlap(bounds, box);
        })
        .map((face) => {
          const room = scene.rooms?.find(
              (r) => r.sourceKey === face.sourceKey && r.geometricallyClosed,
            ),
            label = roomLabelPoint(face),
            area =
              polygonArea(face.boundary) -
              face.holes.reduce((s, h) => s + polygonArea(h), 0);
          return (
            <Group key={face.sourceKey}>
              <Shape
                fill={room?.id === selection ? "#d9eee4" : "#f2f8f4"}
                opacity={0.75}
                fillRule="evenodd"
                sceneFunc={(context, shape) => {
                  context.beginPath();
                  for (const ring of [face.boundary, ...face.holes]) {
                    context.moveTo(ring[0].x, ring[0].y);
                    for (const p of ring.slice(1)) context.lineTo(p.x, p.y);
                    context.closePath();
                  }
                  context.fillStrokeShape(shape);
                }}
              />
              <Text
                x={label.x - 60 / scale}
                y={label.y - 14 / scale}
                width={120 / scale}
                align="center"
                text={`${room?.name || "Контур замера"}\n${quantity(area, "м²")}`}
                fontSize={12 / scale}
                lineHeight={1.5}
                fill="#476f60"
              />
            </Group>
          );
        })}
    </>
  );
}
