import { zipSync } from "fflate";
import type { ProjectSnapshot } from "../../domain/model";
import { defectQuantities } from "../../infrastructure/media-repository";
import { segment } from "../export/paths";
import {
  buildStatement,
  estimate,
  units,
  type WorkPrice,
  type Scope,
  type Section,
} from "./model";
export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export type Cell = string | number | null;
interface Sheet {
  name: string;
  rows: Cell[][];
  widths?: number[];
  moneyColumns?: number[];
}
const xml = (value: string) =>
  Array.from(value)
    .map((c) => {
      const code = c.codePointAt(0)!;
      return (code < 32 && ![9, 10, 13].includes(code)) ||
        code === 0xfffe ||
        code === 0xffff ||
        (code >= 0xd800 && code <= 0xdfff)
        ? "�"
        : c;
    })
    .join("")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\r/g, "&#13;");
const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const namespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
function column(index: number) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}
/** No user content becomes a formula, URL, macro or external relationship. */
export function createWorkbook(sheets: Sheet[]): Uint8Array {
  if (!sheets.length || sheets.length > 32)
    throw new Error("Недопустимое количество листов XLSX");
  const encoder = new TextEncoder(),
    files: Record<string, Uint8Array> = Object.create(null),
    names = new Set<string>();
  let size = 0,
    cellSize = 0;
  const guardedCell = (cell: string) => {
    cellSize += encoder.encode(cell).length;
    if (cellSize > 64 * 1024 * 1024)
      throw new Error("Таблицы XLSX превышают 64 МБ; сузьте область документа");
    return cell;
  };
  const add = (path: string, content: string) => {
    const bytes = encoder.encode(head + content);
    size += bytes.length;
    if (size > 64 * 1024 * 1024)
      throw new Error("Таблицы XLSX превышают 64 МБ; сузьте область документа");
    files[path] = bytes;
  };
  for (let n = 0; n < sheets.length; n++) {
    const sheet = sheets[n];
    if (
      !sheet.name ||
      sheet.name.length > 31 ||
      /[\\/*?:[\]]/.test(sheet.name) ||
      sheet.name.startsWith("'") ||
      sheet.name.endsWith("'") ||
      Array.from(sheet.name).some((c) => c.charCodeAt(0) < 32) ||
      names.has(sheet.name.toLocaleLowerCase())
    )
      throw new Error("Недопустимое имя листа XLSX");
    names.add(sheet.name.toLocaleLowerCase());
    if (sheet.rows.length > 50001 || sheet.rows.some((r) => r.length > 100))
      throw new Error("Слишком большая таблица XLSX; сузьте область документа");
    const count = Math.max(1, ...sheet.rows.map((r) => r.length)),
      end = `${column(count - 1)}${Math.max(1, sheet.rows.length)}`;
    const rows = sheet.rows
      .map(
        (row, r) =>
          `<row r="${r + 1}" ht="${r === 0 ? 30 : 42}" customHeight="1">${row
            .map((value, c) => {
              if (value === null) return "";
              const ref = `${column(c)}${r + 1}`,
                style =
                  r === 0
                    ? 1
                    : typeof value === "number"
                      ? sheet.moneyColumns?.includes(c)
                        ? 3
                        : 2
                      : 0;
              if (typeof value === "number") {
                if (!Number.isFinite(value))
                  throw new Error("Некорректное число XLSX");
                return guardedCell(
                  `<c r="${ref}" s="${style}"><v>${value}</v></c>`,
                );
              }
              if (value.length > 32767)
                throw new Error("Текст ячейки XLSX превышает 32767 символов");
              return guardedCell(
                `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`,
              );
            })
            .join("")}</row>`,
      )
      .join("");
    add(
      `xl/worksheets/sheet${n + 1}.xml`,
      `<worksheet xmlns="${namespace}"><dimension ref="A1:${end}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${Array.from({ length: count }, (_, i) => `<col min="${i + 1}" max="${i + 1}" width="${sheet.widths?.[i] ?? 24}" customWidth="1"/>`).join("")}</cols><sheetData>${rows}</sheetData>${sheet.rows.length > 1 ? `<autoFilter ref="A1:${end}"/>` : ""}<pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.25" footer="0.25"/><pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="0"/></worksheet>`,
    );
  }
  add(
    "[Content_Types].xml",
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
  );
  const relationships =
      "http://schemas.openxmlformats.org/package/2006/relationships",
    office =
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  add(
    "_rels/.rels",
    `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  add(
    "xl/workbook.xml",
    `<workbook xmlns="${namespace}" xmlns:r="${office}"><bookViews><workbookView/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
  );
  add(
    "xl/_rels/workbook.xml.rels",
    `<Relationships xmlns="${relationships}">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${office}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="${office}/styles" Target="styles.xml"/></Relationships>`,
  );
  add(
    "xl/styles.xml",
    `<styleSheet xmlns="${namespace}"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00&quot; ₽&quot;"/><numFmt numFmtId="165" formatCode="0.####"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF17665B"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  );
  const bytes = zipSync(files, { level: 6 });
  if (bytes.length > 52 * 1024 * 1024) throw new Error("XLSX превышает 52 МБ");
  return bytes;
}
export function renderXlsx(
  source: ProjectSnapshot,
  prices: WorkPrice[],
  ownerId: string | null,
  scope: Scope,
  sections: Section[],
  excludedIds: string[] = [],
) {
  if (
    (scope.floorId && !source.floors.some((f) => f.id === scope.floorId)) ||
    (scope.roomId &&
      !source.rooms.some(
        (r) =>
          r.id === scope.roomId &&
          (!scope.floorId || r.floorId === scope.floorId),
      ))
  )
    throw new Error("Область документа недоступна; обновите ведомость");
  if (!sections.some((s) => s !== "plans" && s !== "views"))
    throw new Error("Выберите табличный раздел для XLSX");
  const statement = buildStatement(source, scope),
    costs = estimate(statement.rows, prices, ownerId, excludedIds),
    createdAt = new Date().toISOString();
  const title =
    source.project.name +
    (scope.roomId
      ? " / помещение"
      : scope.floorId
        ? " / этаж"
        : " / полный объект");
  const sheets: Sheet[] = [
    {
      name: "Сведения",
      widths: [32, 90],
      rows: [
        ["Поле", "Значение"],
        ["Объект", source.project.name],
        [
          "Область",
          scope.roomId
            ? (source.rooms.find((r) => r.id === scope.roomId)?.name ??
              "Помещение")
            : scope.floorId
              ? (source.floors.find((f) => f.id === scope.floorId)?.name ??
                "Этаж")
              : "Весь объект",
        ],
        ["Дата снимка (UTC)", createdAt],
        ["Редакция", source.project.revision],
        ["UUID объекта", source.project.id],
        ["Версия модели", source.schemaVersion],
        [
          "Расчёт",
          "Числа — сохранённый снимок расчёта. Неизвестные объёмы/цены пустые; исключённые строки не суммируются. НДС/надбавки не добавлены.",
        ],
        [
          "Правки Excel",
          "Правки файла не изменяют проект и не пересчитывают зафиксированные суммы; создайте новый XLSX из приложения после изменения модели/цен.",
        ],
        [
          "Точность",
          "Числовые ячейки Excel ограничены 15 значащими цифрами. Столбцы исходных значений/копеек содержат точные строки; редактируемая модель сохраняется в project.json полного ZIP.",
        ],
        [
          "Фотографии и изображения",
          "XLSX содержит метаданные и UUID фото. Оригиналы, планы и 3D доступны в полном ZIP; они не встраиваются в XLSX.",
        ],
      ],
    },
  ];
  if (sections.includes("summary"))
    sheets[0].rows.push(
      ["Этажей", statement.analyses.length],
      [
        "Помещений",
        statement.analyses.reduce(
          (n, a) =>
            n +
            a.scene.rooms.filter((r) => !scope.roomId || r.id === scope.roomId)
              .length,
          0,
        ),
      ],
      ["Строк работ", statement.rows.length],
      ["Дефектов", statement.defects.length],
      ["Фото", statement.photos.length],
    );
  if (sections.includes("rooms"))
    sheets.push({
      name: "Помещения",
      rows: [
        [
          "Этаж",
          "Помещение",
          "Статус",
          "Площадь контура, м²",
          "Пол, м²",
          "Потолок, м²",
          "Периметр, м",
          "Высота, м",
          "Объём, м³",
          "Стены до вычетов, м²",
          "Проёмы, м²",
          "Стены после вычетов, м²",
          "Откосы, м²",
          "Замечания",
          "UUID помещения",
        ],
        ...statement.analyses.flatMap((a) =>
          a.calculation.rooms
            .filter((q) => !scope.roomId || q.roomId === scope.roomId)
            .map((q) => {
              const r = source.rooms.find((r) => r.id === q.roomId)!;
              return [
                a.floor.name,
                r.name,
                r.status,
                q.contourArea,
                q.floorArea,
                q.ceilingArea,
                q.perimeter,
                q.height,
                q.volume,
                q.grossWallArea,
                q.openingsArea,
                q.netWallArea,
                q.revealArea,
                q.problems.join("; "),
                r.id,
              ];
            }),
        ),
      ],
    });
  if (sections.includes("quantities"))
    sheets.push({
      name: "Объёмы",
      widths: [30, 40, 10, 18, 26, 70, 60, 40, 40, 12],
      rows: [
        [
          "Расположение",
          "Работа",
          "Ед.",
          "Количество",
          "Исходное количество",
          "Происхождение расчёта",
          "Комментарий",
          "UUID источника",
          "ID строки",
          "Фото, шт.",
        ],
        ...statement.rows.map((r) => [
          r.location,
          r.name,
          units[r.unit],
          r.quantity,
          r.quantity?.toString() ?? "",
          r.explanation,
          r.comment,
          r.sourceId,
          r.id,
          r.photoIds.length,
        ]),
      ],
    });
  if (sections.includes("defects"))
    sheets.push({
      name: "Дефекты",
      rows: [
        [
          "Тип",
          "Описание",
          "Этаж",
          "Помещение",
          "Поверхность",
          "Длина, м",
          "Ширина, м",
          "Глубина, м",
          "Площадь, м²",
          "Объём, м³",
          "Рекомендуемая работа",
          "Статус",
          "Комментарий",
          "UUID дефекта",
        ],
        ...statement.defects.map((d) => {
          const q = defectQuantities(d);
          return [
            d.type,
            d.description,
            source.floors.find((f) => f.id === d.floorId)?.name ?? "Объект",
            source.rooms.find((r) => r.id === d.roomId)?.name ?? "",
            d.surface,
            d.length,
            d.width,
            d.depth,
            q.area,
            q.volume,
            d.recommendedWork,
            d.status,
            d.comment,
            d.id,
          ];
        }),
      ],
    });
  if (sections.includes("estimate"))
    sheets.push({
      name: "Смета",
      widths: [30, 40, 10, 18, 18, 20, 18, 40, 70, 40, 26, 26, 26],
      moneyColumns: [4, 5],
      rows: [
        [
          "Расположение",
          "Работа",
          "Ед.",
          "Количество",
          "Цена, ₽",
          "Сумма, ₽",
          "Включена",
          "Статус расчёта",
          "Происхождение расчёта",
          "UUID источника",
          "Исходное количество",
          "Цена, точные копейки",
          "Сумма, точные копейки",
        ],
        ...costs.lines.map((r) => [
          r.location,
          r.name,
          units[r.unit],
          r.quantity,
          r.price === null ? null : r.price / 100,
          r.cost === null ? null : r.cost / 100,
          r.included ? "Да" : "Нет",
          !r.included
            ? "Исключена"
            : r.quantity === null
              ? "Объём неизвестен"
              : r.price === null
                ? "Цена не задана"
                : r.cost === null
                  ? "Сумма вне допустимого диапазона"
                  : "Рассчитана",
          r.explanation,
          r.sourceId,
          r.quantity?.toString() ?? "",
          r.price?.toString() ?? "",
          r.cost?.toString() ?? "",
        ]),
        [
          costs.complete ? "Итого" : "Промежуточный итог (смета неполная)",
          null,
          null,
          null,
          null,
          costs.subtotal === null ? null : costs.subtotal / 100,
          null,
          costs.subtotal === null
            ? "Итог вне допустимого диапазона"
            : `Строк без суммы: ${costs.missing}`,
          null,
          null,
          null,
          null,
          costs.subtotal?.toString() ?? "",
        ],
      ],
    });
  if (sections.includes("photos"))
    sheets.push({
      name: "Фотографии",
      rows: [
        [
          "Оригинальное имя",
          "Подпись",
          "MIME",
          "Размер, байт",
          "SHA-256",
          "UUID фото",
          "UUID этажа",
          "UUID помещения",
          "UUID элемента",
          "UUID дефекта",
        ],
        ...statement.photos.map((p) => [
          p.originalName,
          p.caption,
          p.mimeType,
          p.size,
          p.checksum,
          p.id,
          p.floorId,
          p.roomId,
          p.elementId,
          p.defectId,
        ]),
      ],
    });
  if (sections.includes("issues"))
    sheets.push({
      name: "Нестыковки",
      rows: [
        [
          "Этаж",
          "Важность",
          "Правило",
          "Описание",
          "X, м",
          "Y, м",
          "UUID элементов",
          "UUID помещений",
        ],
        ...statement.analyses.flatMap((a) =>
          a.issues.map((i) => [
            a.floor.name,
            i.severity,
            i.ruleId,
            i.description,
            i.point.x,
            i.point.y,
            i.elementIds.join("; "),
            i.roomIds.join("; "),
          ]),
        ),
      ],
    });
  if (
    sections.includes("quantities") ||
    sections.includes("estimate") ||
    sections.includes("defects")
  ) {
    const rows =
      sections.includes("quantities") || sections.includes("estimate")
        ? statement.rows
        : statement.rows.filter((r) => r.id.endsWith(":defect"));
    const links: Cell[][] = [];
    for (const row of rows)
      for (const photoId of row.photoIds) {
        if (links.length >= 50000)
          throw new Error(
            "Слишком много связей с фото для XLSX; сузьте область документа",
          );
        links.push([row.id, row.sourceId, photoId]);
      }
    if (links.length)
      sheets.push({
        name: "Связи с фото",
        rows: [["ID строки", "UUID источника", "UUID фото"], ...links],
      });
  }
  const bytes = createWorkbook(sheets);
  return {
    title,
    createdAt,
    rows: statement.rows,
    pageCount: sheets.length,
    files: [
      {
        name: `${segment(source.project.name).slice(0, 60)}_ведомости.xlsx`,
        blob: new Blob([new Uint8Array(bytes).buffer], { type: XLSX_MIME }),
      },
    ],
  };
}
