import { boundsOverlap, pointBounds, type Bounds } from "../../geometry/bounds";
import { useEffect, useState } from "react";
import { liveQuery } from "dexie";
import { Circle, Text, Group, Line } from "react-konva";
import type { Defect } from "../../domain/model";
import { repository } from "../../infrastructure/database";
export function DefectLayer({
  floorId,
  scale,
  bounds,
  onCount,
}: {
  floorId: string;
  scale: number;
  bounds: Bounds;
  onCount: (count: number) => void;
}) {
  const [defects, setDefects] = useState<Defect[]>([]);
  useEffect(() => {
    const sub = liveQuery(async () => {
      const floor = await repository.db.floors.get(floorId);
      if (!floor || !(await repository.get(floor.projectId))) return [];
      return repository.db.defects
        .where({ floorId })
        .filter((d) => !d.deletedAt)
        .toArray();
    }).subscribe({
      next: (rows) => {
        setDefects(rows);
        onCount(rows.length);
      },
      error: () => setDefects([]),
    });
    return () => sub.unsubscribe();
  }, [floorId, onCount]);
  return (
    <>
      {defects.map((d, i) => {
        const box = pointBounds(
          [...d.boundary, ...(d.position ? [d.position] : [])],
          120 / scale,
        );
        if (!box || !boundsOverlap(bounds, box)) return null;
        return (
          <Group key={d.id}>
            {d.boundary.length >= 3 && (
              <Line
                points={d.boundary.flatMap((p) => [p.x, p.y])}
                closed
                fill="#dc4d3f22"
                stroke="#bd4036"
                strokeWidth={1.5 / scale}
              />
            )}
            {d.position && (
              <>
                <Circle
                  x={d.position.x}
                  y={d.position.y}
                  radius={10 / scale}
                  fill={d.status === "open" ? "#bd4036" : "#17665b"}
                  stroke="white"
                  strokeWidth={2 / scale}
                />
                <Text
                  x={d.position.x - 4 / scale}
                  y={d.position.y - 6 / scale}
                  text={String(i + 1)}
                  fontSize={12 / scale}
                  fill="white"
                />
                <Text
                  x={d.position.x + 14 / scale}
                  y={d.position.y - 6 / scale}
                  text={d.type}
                  fontSize={12 / scale}
                  fill="#bd4036"
                />
              </>
            )}
          </Group>
        );
      })}
    </>
  );
}
