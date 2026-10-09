import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { repository } from "../../infrastructure/database";
import {
  DocumentRepository,
  documentFingerprint,
} from "../../infrastructure/document-repository";
import { flushEditors } from "../../editor/flush-editors";
import {
  buildStatement,
  estimate,
  money,
  parsePrice,
  priceKey,
  quantityText,
  sectionLabels,
  units,
  type Scope,
  type Section,
  type Unit,
  type SavedReport,
} from "./model";
import { renderReport } from "./render";
const documents = new DocumentRepository(repository.db);
type Data = Awaited<ReturnType<typeof documents.load>>;
const defaultSections: Section[] = [
  "summary",
  "rooms",
  "quantities",
  "defects",
  "estimate",
  "photos",
  "issues",
  "plans",
];
function download(file: SavedReport["files"][number]) {
  const url = URL.createObjectURL(file.blob),
    a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function PriceField({
  name,
  unit,
  price,
  save,
  disabled,
}: {
  name: string;
  unit: Unit;
  price: number | null;
  save: (name: string, unit: Unit, price: number | null) => Promise<void>;
  disabled: boolean;
}) {
  const [value, setValue] = useState(
      price === null ? "" : (price / 100).toFixed(2),
    ),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const n = value.trim() ? parsePrice(value) : null;
        if (value.trim() && n === null) {
          setError("Введите неотрицательную цену с точностью до копейки");
          return;
        }
        setError("");
        await save(name, unit, n);
      }}
    >
      <label>
        {name} · цена, ₽ / {units[unit]}
        <input
          aria-label={`Цена: ${name}, ${units[unit]}`}
          inputMode="decimal"
          value={value}
          maxLength={24}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <button
        disabled={disabled}
        aria-label={`Сохранить цену: ${name}, ${units[unit]}`}
      >
        Сохранить цену
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
export function DocumentPanel({
  projectId,
  currentFloorId,
}: {
  projectId: string;
  currentFloorId: string;
}) {
  const [data, setData] = useState<Data>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [fingerprint, setFingerprint] = useState("");
  const [scopeValue, setScopeValue] = useState("all"),
    [sections, setSections] = useState<Section[]>(defaultSections),
    [message, setMessage] = useState("");
  const pending = useRef(false),
    active = useRef(true);
  const refresh = useCallback(async () => {
    if (!(await flushEditors()))
      throw new Error(
        "Не удалось сохранить план. Разрешите конфликт или ошибку сохранения перед отчётом.",
      );
    const next = await documents.load(projectId),
      hash = await documentFingerprint(
        next.source,
        next.prices,
        next.excludedIds,
      );
    if (active.current) {
      setData(next);
      setFingerprint(hash);
    }
    return next;
  }, [projectId]);
  useEffect(() => {
    active.current = true;
    void refresh().catch((e) => {
      if (active.current)
        setError(
          e instanceof Error ? e.message : "Не удалось открыть ведомость",
        );
    });
    return () => {
      active.current = false;
    };
  }, [refresh]);
  const scope: Scope = scopeValue.startsWith("f:")
    ? { floorId: scopeValue.slice(2), roomId: null }
    : scopeValue.startsWith("r:")
      ? {
          floorId:
            data?.source.rooms.find((r) => r.id === scopeValue.slice(2))
              ?.floorId ?? null,
          roomId: scopeValue.slice(2),
        }
      : { floorId: null, roomId: null };
  const statement = data ? buildStatement(data.source, scope) : null,
    costs =
      data && statement
        ? estimate(statement.rows, data.prices, data.ownerId, data.excludedIds)
        : null;
  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (active.current)
        setError(
          e instanceof Error
            ? e.message
            : "Не удалось сохранить документ или цену. Проверьте свободное место.",
        );
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function generate(format: "pdf" | "jpeg" | "xlsx") {
    await run(async () => {
      const next = await refresh();
      const output =
        format === "xlsx"
          ? (await import("./xlsx")).renderXlsx(
              next.source,
              next.prices,
              next.ownerId,
              scope,
              sections,
              next.excludedIds,
            )
          : await renderReport(
              next.source,
              next.prices,
              next.ownerId,
              scope,
              sections,
              next.photos,
              format,
              next.excludedIds,
            );
      const report: SavedReport = {
        ...output,
        id: crypto.randomUUID(),
        projectId,
        ownerId: next.ownerId,
        sourceRevision: next.source.project.revision,
        sourceFingerprint: await documentFingerprint(
          next.source,
          next.prices,
          next.excludedIds,
        ),
        sections: [...sections],
        scope: { ...scope },
        excludedIds: next.excludedIds,
        format,
        source: next.source,
        prices: next.prices,
      };
      await documents.save(report);
      await refresh();
      if (active.current)
        setMessage(
          `Документ сохранён на устройстве: ${output.pageCount} ${format === "xlsx" ? "листов" : "стр."}. Откройте файл в истории ниже.`,
        );
    });
  }
  const catalog = costs
    ? [
        ...new Map(
          costs.lines.map((r) => [priceKey(data!.ownerId, r.name, r.unit), r]),
        ).values(),
      ]
    : [];
  return (
    <section
      className="document-panel"
      data-testid="document-panel"
      aria-busy={busy}
    >
      <h2>Ведомости, смета и документы</h2>
      <p>
        Объёмы берутся из модели. Работы предложены автоматически — проверьте
        состав и пересечения дефектных работ с общей отделкой. Цены и история
        документов хранятся на этом устройстве и переносятся через полный ZIP
        проекта.
      </p>
      <button
        disabled={busy}
        onClick={() =>
          void run(async () => {
            await refresh();
            setMessage("Ведомость обновлена из сохранённого плана");
          })
        }
      >
        Обновить ведомость из плана
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {!data ? (
        <p>Читаем сохранённые данные…</p>
      ) : (
        <>
          <label>
            Область документа
            <select
              aria-label="Область документа"
              disabled={busy}
              value={scopeValue}
              onChange={(e) => setScopeValue(e.target.value)}
            >
              <option value="all">Весь объект</option>
              {data.source.floors.map((f) => (
                <option key={f.id} value={`f:${f.id}`}>
                  {f.name}
                </option>
              ))}
              {data.source.rooms.map((r) => (
                <option key={r.id} value={`r:${r.id}`}>
                  {data.source.floors.find((f) => f.id === r.floorId)?.name} /{" "}
                  {r.name || "Без названия"}
                </option>
              ))}
            </select>
          </label>
          <details open>
            <summary>
              Ведомость объёмов и работ · {statement!.rows.length} строк
            </summary>
            {!costs!.lines.length && (
              <p>
                Добавьте помещение в замкнутом контуре или дефект в плане.
                Объёмы появятся без повторного ввода.
              </p>
            )}
            <div className="statement-list">
              {costs!.lines.map((row) => (
                <article
                  key={row.id}
                  data-testid="work-row"
                  data-source-id={row.sourceId}
                >
                  <h3>{row.name}</h3>
                  <label className="work-inclusion">
                    <input
                      type="checkbox"
                      aria-label={`Включить в смету: ${row.location} / ${row.name}`}
                      checked={row.included}
                      disabled={busy}
                      onChange={(e) => {
                        const excluded = e.target.checked
                          ? data.excludedIds.filter((id) => id !== row.id)
                          : [...data.excludedIds, row.id];
                        setData((prev) =>
                          prev ? { ...prev, excludedIds: excluded } : prev,
                        );
                        void run(async () => {
                          try {
                            await documents.setExcluded(projectId, excluded);
                            await refresh();
                          } catch (error) {
                            setData((prev) =>
                              prev
                                ? { ...prev, excludedIds: data.excludedIds }
                                : prev,
                            );
                            throw error;
                          }
                        });
                      }}
                    />
                    Включить в смету
                  </label>
                  <p>
                    {row.location} ·{" "}
                    <strong>{quantityText(row.quantity, row.unit)}</strong>
                  </p>
                  <p>
                    Цена: {row.price === null ? "не задана" : money(row.price)};
                    стоимость:{" "}
                    {!row.included
                      ? "исключена из сметы"
                      : row.cost === null
                        ? "не определена"
                        : money(row.cost)}
                  </p>
                  <details>
                    <summary>Происхождение расчёта</summary>
                    <p>{row.explanation}</p>
                    <p>{row.comment}</p>
                    <p>UUID источника: {row.sourceId}</p>
                    {row.floorId && (
                      <Link to={`/projects/${projectId}/floors/${row.floorId}`}>
                        Открыть этаж источника
                      </Link>
                    )}
                    <p>Фото: {row.photoIds.join(", ") || "нет"}</p>
                  </details>
                </article>
              ))}
            </div>
            <p data-testid="estimate-total">
              <strong>
                {costs!.complete
                  ? "Итого"
                  : "Промежуточный итог (смета неполная)"}
                :{" "}
                {costs!.subtotal === null
                  ? "сумма вне диапазона"
                  : money(costs!.subtotal)}
              </strong>{" "}
              · строк без суммы: {costs!.missing}
            </p>
          </details>
          <details>
            <summary>Справочник цен</summary>
            {data.hasImportedPrices && (
              <p>
                В этом объекте сохранены цены импортированного проекта. Они не
                меняют общий справочник. При редактировании цена записывается в
                справочник, а отдельная цена этой копии заменяется.
              </p>
            )}
            <p>
              Одна цена вида работ и единицы применяется ко всем его строкам и
              объектам этого аккаунта на устройстве. Пустая цена удаляет запись.
              НДС и надбавки автоматически не добавляются.
            </p>
            <div className="price-list">
              {catalog.map((row) => (
                <PriceField
                  key={
                    priceKey(data.ownerId, row.name, row.unit) + ":" + row.price
                  }
                  name={row.name}
                  unit={row.unit}
                  price={row.price}
                  disabled={busy}
                  save={async (name, unit, n) =>
                    run(async () => {
                      await documents.setPrice(name, unit, n, projectId);
                      await refresh();
                      setMessage("Цена сохранена в справочнике");
                    })
                  }
                />
              ))}
            </div>
          </details>
          <fieldset disabled={busy}>
            <legend>Состав документа</legend>
            <label>
              Шаблон
              <select
                aria-label="Шаблон документа"
                defaultValue="report"
                onChange={(e) => {
                  const key = e.target.value;
                  setSections(
                    key === "report" || key === "floor" || key === "room"
                      ? defaultSections
                      : [key as Section],
                  );
                  if (key === "floor") setScopeValue(`f:${currentFloorId}`);
                  if (key === "report") setScopeValue("all");
                  if (key === "room") {
                    const r = data.source.rooms.find(
                      (r) => r.floorId === currentFloorId,
                    );
                    if (r) setScopeValue(`r:${r.id}`);
                    else setError("Сначала добавьте помещение в план");
                  }
                }}
              >
                <option value="report">Полный отчёт объекта</option>
                <option value="floor">Отчёт текущего этажа</option>
                <option value="room">Отчёт помещения</option>
                <option value="defects">Дефектная ведомость</option>
                <option value="quantities">Ведомость объёмов</option>
                <option value="estimate">Смета</option>
                <option value="photos">Фотоотчёт</option>
                <option value="issues">Список нестыковок</option>
                <option value="summary">Краткая сводка</option>
              </select>
            </label>
            <div className="report-sections">
              {(Object.keys(sectionLabels) as Section[]).map((key) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={sections.includes(key)}
                    onChange={(e) =>
                      setSections((prev) =>
                        e.target.checked
                          ? [...prev, key]
                          : prev.filter((s) => s !== key),
                      )
                    }
                  />
                  {sectionLabels[key]}
                </label>
              ))}
            </div>
            <button
              disabled={!sections.length}
              onClick={() => void generate("pdf")}
            >
              Создать PDF
            </button>
            <button
              disabled={!sections.length}
              onClick={() => void generate("jpeg")}
            >
              Создать JPEG
            </button>
            <button
              disabled={!sections.some((s) => s !== "plans" && s !== "views")}
              onClick={() => void generate("xlsx")}
            >
              Создать XLSX
            </button>
          </fieldset>
          <p>
            XLSX содержит табличные разделы и зафиксированные суммы. Правки
            Excel не изменяют проект и не пересчитывают этот снимок; изображения
            и оригиналы доступны в ZIP.
          </p>
          <p>
            JPEG сохраняется отдельным файлом для каждой страницы. Оригиналы
            фото остаются в разделе фотографий; отчёт содержит уменьшенные
            копии. 3D — визуализация замера, без BIM. Для отчёта помещения планы
            показывают этаж целиком.
          </p>
          <h3>История документов на устройстве</h3>
          {!data.documents.length && (
            <p>Документов пока нет. Выберите состав и формат.</p>
          )}
          {data.documents.map((doc) => (
            <article
              className="saved-report"
              data-testid="saved-report"
              key={doc.id}
            >
              <h4>{doc.title}</h4>
              <p>
                {new Date(doc.createdAt).toLocaleString("ru-RU")} ·{" "}
                {doc.format.toUpperCase()} · {doc.pageCount}{" "}
                {doc.format === "xlsx" ? "листов" : "стр."} · редакция{" "}
                {doc.sourceRevision}
              </p>
              <p>
                {doc.sourceFingerprint === fingerprint
                  ? "Соответствует прочитанным данным"
                  : "Снимок прежних данных или цен — создайте новый документ"}
              </p>
              {doc.files.map((file) => (
                <button key={file.name} onClick={() => download(file)}>
                  Скачать {file.name}
                </button>
              ))}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
