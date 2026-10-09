import type { ProjectSnapshot } from "../../domain/model";
import { CalculationEngine } from "../../calculation/engine";
import { defectQuantities } from "../../infrastructure/media-repository";
import { evaluateIssues } from "../../issues/engine";
export type Unit = "m" | "m2" | "m3" | "pcs";
export const units: Record<Unit, string> = {
  m: "м",
  m2: "м²",
  m3: "м³",
  pcs: "шт.",
};
export interface WorkRow {
  id: string;
  sourceId: string;
  floorId: string;
  roomId: string | null;
  name: string;
  location: string;
  unit: Unit;
  quantity: number | null;
  explanation: string;
  comment: string;
  photoIds: string[];
}
export interface EstimateSettings {
  id: string;
  projectId: string;
  ownerId: string | null;
  excludedIds: string[];
}
export interface WorkPrice {
  id: string;
  ownerId: string | null;
  name: string;
  unit: Unit;
  kopecks: number;
  updatedAt: string;
}
export const priceKey = (ownerId: string | null, name: string, unit: Unit) =>
  JSON.stringify([
    ownerId,
    name.trim().normalize("NFC").toLocaleLowerCase("ru-RU"),
    unit,
  ]);
export function parsePrice(value: string): number | null {
  const s = value.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [rubles, fraction = ""] = s.split(".");
  const n = Number(rubles) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(n) && n <= 1_000_000_000_000 ? n : null;
}
export const money = (kopecks: number) =>
  (kopecks / 100).toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + " ₽";
const numericText = (q: number | null) =>
  q === null
    ? "неизвестно"
    : q.toLocaleString("ru-RU", { maximumFractionDigits: 4 });
export const quantityText = (q: number | null, unit: Unit) =>
  q === null
    ? "Объём неизвестен"
    : q.toLocaleString("ru-RU", { maximumFractionDigits: 4 }) +
      " " +
      units[unit];
// Round each line once, from the unrounded geometric quantity, using integer currency.
export function lineCost(
  quantity: number | null,
  kopecks: number | null,
): number | null {
  if (
    quantity === null ||
    kopecks === null ||
    !Number.isFinite(quantity) ||
    quantity < 0 ||
    !Number.isSafeInteger(kopecks) ||
    kopecks < 0
  )
    return null;
  const [mantissa, exponent = "0"] = quantity.toString().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const scale = fraction.length - Number(exponent);
  let numerator = BigInt(whole + fraction) * BigInt(kopecks);
  let denominator = 1n;
  if (scale > 0) denominator = 10n ** BigInt(scale);
  else numerator *= 10n ** BigInt(-scale);
  const cost = (numerator * 2n + denominator) / (denominator * 2n);
  return cost <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cost) : null;
}
export interface Scope {
  floorId: string | null;
  roomId: string | null;
}
export function buildStatement(
  snapshot: ProjectSnapshot,
  scope: Scope = { floorId: null, roomId: null },
) {
  const floors = snapshot.floors.filter(
    (f) => !scope.floorId || f.id === scope.floorId,
  );
  const rows: WorkRow[] = [];
  const analyses = floors.map((floor) => {
    const scene = {
      walls: snapshot.walls.filter((w) => w.floorId === floor.id),
      elements: snapshot.elements.filter((e) => e.floorId === floor.id),
      rooms: snapshot.rooms.filter((r) => r.floorId === floor.id),
      junctions: snapshot.junctions.filter((j) => j.floorId === floor.id),
      dimensions: snapshot.dimensions.filter((d) => d.floorId === floor.id),
    };
    const calculation = new CalculationEngine().evaluate(
      scene,
      floor.defaultHeight,
    );
    const issues = evaluateIssues({
      floorId: floor.id,
      scene,
      height: floor.defaultHeight,
    });
    for (const room of scene.rooms.filter(
      (r) => !scope.roomId || r.id === scope.roomId,
    )) {
      const q = calculation.rooms.find((r) => r.roomId === room.id)!;
      const location = `${floor.name} / ${room.name || "Без названия"}`;
      const photoIds = snapshot.photos
        .filter((p) => !p.deletedAt && p.roomId === room.id)
        .map((p) => p.id);
      const add = (
        key: string,
        name: string,
        quantity: number | null,
        explanation: string,
      ) =>
        rows.push({
          id: `${room.id}:${key}`,
          sourceId: room.id,
          floorId: floor.id,
          roomId: room.id,
          location,
          name,
          quantity,
          unit: "m2",
          explanation,
          comment: q.problems.join("; "),
          photoIds,
        });
      add(
        "floor",
        "Отделка пола",
        q.floorArea,
        `Площадь контура ${numericText(q.contourArea)} м² − объединённые следы колонн = ${numericText(q.floorArea)} м²`,
      );
      add(
        "ceiling",
        "Отделка потолка",
        q.ceilingArea,
        "Площадь контура − следы колонн и балок; методика расчёта помещения",
      );
      add(
        "walls",
        "Штукатурка стен",
        q.netWallArea,
        `Площадь стен ${numericText(q.grossWallArea)} м² − окна ${numericText(q.windowArea)} м² − двери ${numericText(q.doorArea)} м² − прочие проёмы ${numericText(q.voidArea)} м² = ${numericText(q.netWallArea)} м². Перекрытия объединяются; общая стена учитывается по стороне помещения.`,
      );
      add(
        "reveals",
        "Отделка откосов",
        q.revealArea,
        "Длина откосов × глубина каждого проёма; двери без нижнего откоса",
      );
    }
    // Structural quantities come from the calculation engine, never from rendered mesh volume.
    for (const element of scene.elements.filter(
      (e) =>
        (e.kind === "column" ||
          e.kind === "beam" ||
          e.kind === "stair" ||
          e.kind === "ramp") &&
        (!scope.roomId || e.roomIds.includes(scope.roomId)),
    )) {
      const q = calculation.floor.elements.find((e) => e.id === element.id)!;
      rows.push({
        id: `${element.id}:volume`,
        sourceId: element.id,
        floorId: floor.id,
        roomId: null,
        name:
          element.kind === "column"
            ? "Устройство колонны"
            : element.kind === "beam"
              ? "Устройство балки"
              : element.kind === "stair"
                ? "Устройство лестницы (расчётный объём)"
                : "Устройство пандуса (расчётный объём)",
        location: floor.name,
        unit: "m3",
        quantity: q.volume,
        explanation:
          element.kind === "stair"
            ? "Ширина × длина × подъём × (число ступеней + 1) / (2 × число ступеней). Допущение: сплошные ступени, без площадок; проверьте конструктивную толщину."
            : element.kind === "ramp"
              ? "Ширина × длина × модуль подъёма / 2. Допущение: клин, без основания; визуальная толщина 3D не включается."
              : "Площадь сечения × высота/длина, с учётом полостей и объединения составных частей",
        comment: q.problems.join("; "),
        photoIds: snapshot.photos
          .filter((p) => p.elementId === element.id && !p.deletedAt)
          .map((p) => p.id),
      });
      rows.push({
        ...rows.at(-1)!,
        id: `${element.id}:surface`,
        unit: "m2",
        name:
          element.kind === "column"
            ? "Поверхности колонны"
            : element.kind === "beam"
              ? "Поверхности балки"
              : element.kind === "stair"
                ? "Отделка ступеней"
                : "Отделка пандуса",
        quantity: q.surfaceArea,
        explanation:
          element.kind === "column"
            ? "Периметры сечения × высота + две площади сечения; все поверхности, включая полости и торцы"
            : element.kind === "beam"
              ? "2 × (длина × ширина + длина × высота + ширина × высота); все грани"
              : element.kind === "stair"
                ? "Ширина × (длина + подъём): проступи и подступёнки, без боковых граней"
                : "Ширина × гипотенуза длины и подъёма: наклонная поверхность",
      });
    }
    return {
      floor,
      scene,
      calculation,
      issues: issues.filter(
        (i) => !scope.roomId || i.roomIds.includes(scope.roomId),
      ),
    };
  });
  const defects = snapshot.defects.filter(
    (d) =>
      !d.deletedAt &&
      (!scope.floorId || d.floorId === scope.floorId) &&
      (!scope.roomId || d.roomId === scope.roomId),
  );
  for (const d of defects) {
    const q = defectQuantities(d),
      unit: Unit = d.depth !== null ? "m3" : d.width !== null ? "m2" : "m";
    rows.push({
      id: `${d.id}:defect`,
      sourceId: d.id,
      floorId: d.floorId ?? "",
      roomId: d.roomId,
      name: d.recommendedWork || `Устранение дефекта: ${d.type}`,
      location:
        [
          snapshot.floors.find((f) => f.id === d.floorId)?.name,
          snapshot.rooms.find((r) => r.id === d.roomId)?.name,
        ]
          .filter(Boolean)
          .join(" / ") || "Объект",
      unit,
      quantity: unit === "m3" ? q.volume : unit === "m2" ? q.area : d.length,
      explanation:
        unit === "m3"
          ? "Длина × ширина × глубина дефекта"
          : unit === "m2"
            ? "Длина × ширина дефекта"
            : "Длина дефекта (прочие размеры не заданы)",
      comment: [
        d.description,
        d.surface,
        d.comment,
        `Статус: ${d.status === "resolved" ? "устранён" : "открыт"}`,
      ]
        .filter(Boolean)
        .join("; "),
      photoIds: snapshot.photos
        .filter((p) => p.defectId === d.id && !p.deletedAt)
        .map((p) => p.id),
    });
  }
  const photos = snapshot.photos.filter(
    (p) =>
      !p.deletedAt &&
      (!scope.floorId || p.floorId === scope.floorId) &&
      (!scope.roomId || p.roomId === scope.roomId),
  );
  return { rows, analyses, defects, photos };
}
export function estimate(
  rows: readonly WorkRow[],
  prices: readonly WorkPrice[],
  ownerId: string | null,
  excludedIds: readonly string[] = [],
) {
  const lines = rows.map((row) => {
    const price =
      prices.find((p) => p.id === priceKey(ownerId, row.name, row.unit))
        ?.kopecks ?? null;
    const included = !excludedIds.includes(row.id);
    return {
      ...row,
      price,
      included,
      cost: included ? lineCost(row.quantity, price) : null,
    };
  });
  const sum = lines.reduce((n, r) => n + (r.cost ?? 0), 0);
  return {
    lines,
    subtotal: Number.isSafeInteger(sum) ? sum : null,
    missing: lines.filter((r) => r.included && r.cost === null).length,
    complete:
      Number.isSafeInteger(sum) &&
      lines.every((r) => !r.included || r.cost !== null),
  };
}
export const sectionLabels = {
  summary: "Краткая сводка",
  rooms: "Помещения",
  quantities: "Ведомость объёмов и работ",
  defects: "Дефектная ведомость",
  estimate: "Смета",
  photos: "Фотоотчёт",
  issues: "Список нестыковок",
  plans: "Планы 2D",
  views: "Виды 3D",
};
export type Section = keyof typeof sectionLabels;
export interface SavedReport {
  excludedIds?: string[];
  id: string;
  projectId: string;
  ownerId: string | null;
  createdAt: string;
  sourceRevision: number;
  sourceFingerprint: string;
  title: string;
  sections: Section[];
  scope: Scope;
  format: "pdf" | "jpeg" | "xlsx";
  files: { name: string; blob: Blob }[];
  pageCount: number;
  // Immutable source/price provenance; spreadsheet adapters can reuse these typed rows.
  source: ProjectSnapshot;
  prices: WorkPrice[];
  rows: WorkRow[];
}
