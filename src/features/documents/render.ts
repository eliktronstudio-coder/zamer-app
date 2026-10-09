import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import {
  buildStatement,
  estimate,
  money,
  quantityText,
  sectionLabels,
  units,
  type Scope,
  type Section,
  type WorkPrice,
} from "./model";
import type { ProjectSnapshot } from "../../domain/model";
import type { PhotoFile } from "../../infrastructure/database";
import { planImage, viewImage } from "./images";
export const safeFileName = (name: string) =>
  [...name.normalize("NFC")]
    .map((c) => (c.charCodeAt(0) < 32 ? "_" : c))
    .join("")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 100) || "Документ";
type Draw =
  | { kind: "text"; text: string; x: number; y: number; size: number }
  | {
      kind: "image";
      data: string;
      x: number;
      y: number;
      width: number;
      height: number;
    };
const W = 595.28,
  H = 841.89,
  M = 40;
const roomStatuses = {
  notStarted: "Не начато",
  inProgress: "В работе",
  issues: "Есть нестыковки",
  completed: "Завершено",
  completedWithNotes: "Завершено с замечаниями",
};
const severities = {
  info: "Информация",
  warning: "Предупреждение",
  error: "Ошибка",
};
export class ReportLayout {
  pages: Draw[][] = [[]];
  y = M;
  constructor(readonly font: PDFFont) {}
  clean(s: string) {
    const supported = new Set(this.font.getCharacterSet());
    return [
      ...[...s].filter((c) => c === "\n" || c.charCodeAt(0) >= 32).join(""),
    ]
      .map((c) => (c === "\n" || supported.has(c.codePointAt(0)!) ? c : "?"))
      .join("");
  }
  page() {
    this.pages.push([]);
    this.y = M;
  }
  space(h: number) {
    if (this.y + h > H - M - 20) this.page();
  }
  text(s: string, size = 10) {
    const max = W - 2 * M,
      input = this.clean(s);
    for (const paragraph of input.split("\n")) {
      let line = "";
      // Character-level fallback prevents long UUIDs, filenames and user words from overflowing.
      const tokens = paragraph.split(/(\s+)/);
      for (const token of tokens) {
        if (line && this.font.widthOfTextAtSize(line + token, size) > max) {
          this.line(line.trimEnd(), size);
          line = "";
        }
        for (const c of token) {
          if (line && this.font.widthOfTextAtSize(line + c, size) > max) {
            this.line(line.trimEnd(), size);
            line = "";
          }
          line += c;
        }
      }
      this.line(line.trimEnd(), size);
    }
    this.y += 4;
  }
  line(text: string, size: number) {
    this.space(size * 1.5);
    this.pages.at(-1)!.push({ kind: "text", text, x: M, y: this.y, size });
    this.y += size * 1.5;
  }
  image(data: string, width = 515, height = 300) {
    this.space(height + 8);
    this.pages
      .at(-1)!
      .push({ kind: "image", data, x: M, y: this.y, width, height });
    this.y += height + 12;
  }
}
async function photoData(blob: Blob) {
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(blob);
    const c = document.createElement("canvas"),
      ratio = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    c.width = Math.max(1, Math.round(bitmap.width * ratio));
    c.height = Math.max(1, Math.round(bitmap.height * ratio));
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bitmap, 0, 0, c.width, c.height);
    return { data: c.toDataURL("image/jpeg", 0.85), ratio: c.width / c.height };
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}
export async function renderReport(
  source: ProjectSnapshot,
  prices: WorkPrice[],
  ownerId: string | null,
  scope: Scope,
  sections: Section[],
  photos: PhotoFile[],
  format: "pdf" | "jpeg",
  excludedIds: string[] = [],
) {
  if (!sections.length) throw new Error("Выберите хотя бы один раздел");
  if (scope.floorId && !source.floors.some((f) => f.id === scope.floorId))
    throw new Error("Этаж отчёта недоступен; выберите область заново");
  if (
    scope.roomId &&
    !source.rooms.some(
      (r) =>
        r.id === scope.roomId &&
        (!scope.floorId || r.floorId === scope.floorId),
    )
  )
    throw new Error("Помещение отчёта недоступно; выберите область заново");
  const response = await fetch("/fonts/DejaVuSans.ttf");
  if (!response.ok)
    throw new Error(
      "Шрифт отчёта недоступен; откройте приложение с сетью один раз",
    );
  const fontBytes = await response.arrayBuffer(),
    pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes, { subset: true });
  const browserFont = new FontFace("ZamerReport", fontBytes);
  await browserFont.load();
  document.fonts.add(browserFont);
  try {
    const layout = new ReportLayout(font),
      statement = buildStatement(source, scope),
      costs = estimate(statement.rows, prices, ownerId, excludedIds),
      createdAt = new Date().toISOString();
    const title =
      source.project.name +
      (scope.roomId
        ? " / " +
          (source.rooms.find((r) => r.id === scope.roomId)?.name || "Помещение")
        : scope.floorId
          ? " / " + source.floors.find((f) => f.id === scope.floorId)?.name
          : " / полный объект");
    layout.text(title, 18);
    layout.text(
      `Замер · ${new Date(createdAt).toLocaleString("ru-RU")} · редакция ${source.project.revision}`,
    );
    layout.text(
      "Снимок локально сохранённых данных. Недостоверные объёмы и незаданные цены не заменяются нулём. Цены в рублях, без автоматических налогов/надбавок. Работы предложены по модели: проверьте их состав перед использованием.",
    );
    const measurementComplete = scope.roomId
      ? statement.analyses.some((a) =>
          a.calculation.rooms.some(
            (r) => r.roomId === scope.roomId && r.complete,
          ),
        )
      : statement.analyses.every((a) => a.calculation.floor.complete);
    if (!measurementComplete)
      layout.text(
        "Замер неполный или содержит нестыковки. Ведомость включает только зарегистрированные помещения и доступные данные; добавьте оставшиеся контуры и проверьте план.",
      );
    for (const section of sections) {
      layout.text(sectionLabels[section], 15);
      if (section === "summary") {
        layout.text(
          `Этажей: ${statement.analyses.length}; помещений: ${statement.analyses.reduce((n, a) => n + a.scene.rooms.filter((r) => !scope.roomId || r.id === scope.roomId).length, 0)}; дефектов: ${statement.defects.length}; фото: ${statement.photos.length}`,
        );
        layout.text(
          `Учтённая стоимость: ${costs.subtotal === null ? "Превышен допустимый диапазон" : money(costs.subtotal)}. ${costs.complete ? "Все строки оценены" : "Смета неполная: строк без суммы " + costs.missing}`,
        );
        layout.text(
          "Площади стен считаются по сторонам помещений; общая стена может иметь две отделываемые поверхности. Дефектные работы могут пересекаться с общей отделкой: проверьте отсутствие двойного заказа.",
        );
      }
      if (section === "rooms") {
        for (const a of statement.analyses)
          for (const r of a.scene.rooms.filter(
            (r) => !scope.roomId || r.id === scope.roomId,
          )) {
            const q = a.calculation.rooms.find((q) => q.roomId === r.id)!;
            layout.text(
              `${a.floor.name} / ${r.name || "Без названия"} · ${roomStatuses[r.status]} · UUID ${r.id}`,
            );
            layout.text(
              `Пол: ${quantityText(q.floorArea, "m2")}; потолок: ${quantityText(q.ceilingArea, "m2")}; стены: ${quantityText(q.netWallArea, "m2")}; объём: ${quantityText(q.volume, "m3")}. ${q.problems.join("; ")}`,
            );
          }
        if (!source.rooms.length)
          layout.text(
            "Помещения ещё не добавлены. Замкните контур и добавьте помещение в 2D.",
          );
      }
      if (section === "quantities" || section === "estimate") {
        if (!statement.rows.length)
          layout.text("Нет работ: добавьте помещения или дефекты в плане.");
        for (const row of costs.lines.filter(
          (r) => section === "quantities" || r.included,
        )) {
          layout.text(
            `${row.location} · ${row.name} — ${quantityText(row.quantity, row.unit)}`,
            11,
          );
          if (section === "estimate")
            layout.text(
              `Цена: ${row.price === null ? "не задана" : money(row.price) + " / " + units[row.unit]}; сумма: ${row.cost === null ? "не определена" : money(row.cost)}`,
            );
          layout.text(`Источник ${row.sourceId}. ${row.explanation}`);
          if (row.comment) layout.text(row.comment);
          if (row.photoIds.length)
            layout.text("Связанные фото: " + row.photoIds.join(", "));
        }
        if (section === "estimate")
          layout.text(
            `${costs.complete ? "Итого" : "Промежуточный итог (неполная смета)"}: ${costs.subtotal === null ? "сумма вне диапазона" : money(costs.subtotal)}; строк без суммы: ${costs.missing}`,
            12,
          );
      }
      if (section === "defects") {
        for (const d of statement.defects) {
          layout.text(
            `${d.type} · ${d.status === "open" ? "открыт" : "устранён"} · UUID ${d.id}`,
            11,
          );
          layout.text(d.description);
          layout.text(
            `Поверхность: ${d.surface || "не указана"}; работа: ${d.recommendedWork || "не указана"}; ${d.comment}`,
          );
          const row = statement.rows.find((r) => r.sourceId === d.id)!;
          layout.text(
            `${quantityText(row.quantity, row.unit)}. ${row.explanation}. Фото: ${row.photoIds.join(", ") || "нет"}`,
          );
        }
        if (!statement.defects.length)
          layout.text("Дефектов в выбранной области нет.");
      }
      if (section === "issues") {
        let count = 0;
        for (const a of statement.analyses)
          for (const i of a.issues) {
            count++;
            layout.text(
              `${a.floor.name} · ${severities[i.severity]} · ${i.description}`,
            );
            layout.text(`Источник: ${i.elementIds.join(", ") || a.floor.id}`);
          }
        if (!count)
          layout.text("Нестыковок по текущим правилам не обнаружено.");
      }
      if (section === "plans" || section === "views")
        for (const a of statement.analyses) {
          layout.text(a.floor.name, 12);
          const data =
            section === "plans"
              ? planImage(
                  a.scene,
                  a.floor,
                  statement.defects.filter((d) => d.floorId === a.floor.id),
                )
              : await viewImage(a.scene, a.floor);
          if (data) layout.image(data);
          else
            layout.text(
              "3D-снимок недоступен: WebGL не поддерживается. План 2D остаётся доступен.",
            );
          if (scope.roomId)
            layout.text(
              "Обзор всего этажа для ориентации; ведомость ограничена выбранным помещением.",
            );
        }
      if (section === "photos") {
        for (const photo of statement.photos) {
          layout.text(photo.caption || photo.originalName, 11);
          layout.text(
            `UUID ${photo.id}; файл ${photo.originalName}; SHA-256 ${photo.checksum}; источник ${photo.defectId || photo.elementId || photo.roomId || photo.floorId || photo.projectId}`,
          );
          const file = photos.find((f) => f.checksum === photo.checksum);
          const image = file
            ? await photoData(file.preview ?? file.original)
            : null;
          if (image) {
            const width = Math.min(515, 300 * image.ratio);
            layout.image(image.data, width, width / image.ratio);
          } else
            layout.text(
              file
                ? "Формат фото не декодируется: оригинал сохранён отдельно"
                : "Оригинал не загружен на устройство: загрузите его в разделе фото",
            );
        }
        if (!statement.photos.length)
          layout.text("Фотографий в выбранной области нет.");
      }
    }
    const base = safeFileName(title),
      files: { name: string; blob: Blob }[] = [];
    for (let index = 0; index < layout.pages.length; index++) {
      const draws = layout.pages[index],
        footer = `Замер · ${index + 1} / ${layout.pages.length} · редакция ${source.project.revision}`;
      if (format === "pdf") {
        const page: PDFPage = pdf.addPage([W, H]);
        for (const draw of draws) {
          if (draw.kind === "text")
            page.drawText(draw.text, {
              x: draw.x,
              y: H - draw.y - draw.size,
              size: draw.size,
              font,
              color: rgb(0.12, 0.2, 0.24),
            });
          else {
            const image = draw.data.startsWith("data:image/png")
              ? await pdf.embedPng(draw.data)
              : await pdf.embedJpg(draw.data);
            page.drawImage(image, {
              x: draw.x,
              y: H - draw.y - draw.height,
              width: draw.width,
              height: draw.height,
            });
          }
        }
        page.drawText(footer, { x: M, y: 20, font, size: 8 });
      } else {
        const canvas = document.createElement("canvas"),
          scale = 2;
        canvas.width = Math.round(W * scale);
        canvas.height = Math.round(H * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas недоступен");
        ctx.scale(scale, scale);
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, W, H);
        for (const draw of draws) {
          if (draw.kind === "text") {
            ctx.fillStyle = "#20343d";
            ctx.font = `${draw.size}px ZamerReport`;
            ctx.textBaseline = "top";
            ctx.fillText(draw.text, draw.x, draw.y);
          } else {
            const image = new Image();
            image.src = draw.data;
            await image.decode();
            ctx.drawImage(image, draw.x, draw.y, draw.width, draw.height);
          }
        }
        ctx.fillStyle = "#20343d";
        ctx.font = "8px ZamerReport";
        ctx.fillText(footer, M, H - 28);
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", 0.92),
        );
        if (!blob) throw new Error("Не удалось создать JPEG");
        files.push({
          name: `${base}-${String(index + 1).padStart(3, "0")}.jpg`,
          blob,
        });
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    if (format === "pdf") {
      pdf.setTitle(title);
      pdf.setSubject("Замер — ведомость и смета");
      pdf.setCreator("Замер");
      const bytes = await pdf.save();
      files.push({
        name: `${base}.pdf`,
        blob: new Blob([new Uint8Array(bytes).buffer], {
          type: "application/pdf",
        }),
      });
    }
    return {
      title,
      files,
      pageCount: layout.pages.length,
      rows: statement.rows,
      createdAt,
    };
  } finally {
    document.fonts.delete(browserFont);
  }
}
