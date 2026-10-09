import { PagedList } from "../../components/PagedList";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { liveQuery } from "dexie";
import { useStore } from "zustand";
import type { EditorStore } from "../../editor/store";
import type { Defect, Photo, Floor, Point, Binding } from "../../domain/model";
import { repository } from "../../infrastructure/database";
import {
  MediaRepository,
  defectQuantities,
} from "../../infrastructure/media-repository";
import { configuredClient } from "../../infrastructure/supabase-transport";
import { flushEditors } from "../../editor/flush-editors";
import { parseLengthInput } from "../../geometry/walls";
const media = new MediaRepository(repository.db);
const defaults = {
  type: "Трещина",
  description: "",
  boundary: [] as Point[],
  surface: "",
  length: null,
  width: null,
  depth: null,
  comment: "",
  recommendedWork: "",
  status: "open" as const,
  deletedAt: null,
};
function PhotoCard({
  photo,
  refresh,
  onChange,
}: {
  photo: Photo;
  refresh: number;
  onChange: () => void;
}) {
  const [urls, setUrls] = useState<{
      preview: string;
      original: string;
    } | null>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true,
      original = "",
      preview = "";
    void media
      .file(photo.id)
      .then((file) => {
        if (!active) return;
        if (file) {
          original = URL.createObjectURL(file.original);
          preview = file.preview ? URL.createObjectURL(file.preview) : "";
          setUrls({ original, preview });
        } else setUrls(null);
      })
      .catch(() => {
        if (active) setMessage("Не удалось прочитать оригинал");
      });
    return () => {
      active = false;
      if (original) URL.revokeObjectURL(original);
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [photo.id, photo.checksum, refresh]);
  async function download() {
    setBusy(true);
    try {
      const client = configuredClient();
      if (!client)
        throw new Error("Подключите Supabase для загрузки оригинала");
      const { data, error } = await client.storage
        .from("zamer-originals")
        .download(photo.storageKey);
      if (error || !data) throw new Error("Оригинал пока недоступен в облаке");
      await media.cacheOriginal(photo.id, data);
      setMessage("Оригинал проверен и сохранён на устройстве");
      onChange();
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Не удалось загрузить оригинал",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="photo-card" data-testid="photo-card">
      {urls?.preview ? (
        <img
          src={urls.preview}
          alt={photo.caption || photo.originalName}
          loading="lazy"
        />
      ) : (
        <p className="muted">
          {urls
            ? "Превью недоступно в этом браузере"
            : "Оригинал не загружен на устройство"}
        </p>
      )}
      <strong>{photo.originalName}</strong>
      <small>
        {(photo.size / 1048576).toLocaleString("ru-RU", {
          maximumFractionDigits: 2,
        })}{" "}
        МБ · {photo.mimeType}
      </small>
      {photo.caption && <p>{photo.caption}</p>}
      {urls ? (
        <a
          className="button"
          href={urls.original}
          download={photo.originalName}
        >
          Скачать оригинал
        </a>
      ) : (
        <button disabled={busy} onClick={() => void download()}>
          Загрузить оригинал
        </button>
      )}
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void media
            .setPhotoDeleted(photo.id, !photo.deletedAt)
            .then(onChange)
            .catch(() =>
              setMessage("Не удалось изменить фото; оригинал сохранён"),
            )
            .finally(() => setBusy(false));
        }}
      >
        {photo.deletedAt ? "Восстановить фото" : "В корзину фото"}
      </button>
      {message && <p role="status">{message}</p>}
    </article>
  );
}
export function MediaPanel({
  store,
  floor,
  point,
  onPointUsed,
}: {
  store: EditorStore;
  floor: Floor;
  point: Point | null;
  onPointUsed: () => void;
}) {
  const scene = useStore(store, (s) => s.scene),
    selection = useStore(store, (s) => s.selection);
  const [data, setData] = useState<{ defects: Defect[]; photos: Photo[] }>({
      defects: [],
      photos: [],
    }),
    [draft, setDraft] = useState<Defect | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [trash, setTrash] = useState(false),
    [refresh, setRefresh] = useState(0),
    [caption, setCaption] = useState(""),
    [scope, setScope] = useState("floor"),
    [boundary, setBoundary] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const draftId = draft?.id;
  useEffect(() => {
    if (!draftId) return;
    const frame = requestAnimationFrame(() =>
      formRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [draftId]);
  const pending = useRef(false),
    base = useRef<number | null>(null);
  useEffect(() => {
    const sub = liveQuery(() => media.list(floor.projectId)).subscribe({
      next: setData,
      error: () => setError("Не удалось прочитать дефекты и фото"),
    });
    return () => sub.unsubscribe();
  }, [floor.projectId]);
  const records = useMemo(
    () =>
      data.defects.filter(
        (d) => d.floorId === floor.id && !!d.deletedAt === trash,
      ),
    [data.defects, floor.id, trash],
  );
  function fresh(position: Point | null = null) {
    const entity = [...scene.walls, ...(scene.elements ?? [])].find(
        (e) => e.id === selection,
      ),
      room = (scene.rooms ?? []).find((r) => r.id === selection);
    const now = new Date().toISOString();
    base.current = null;
    setBoundary("");
    setDraft({
      ...defaults,
      id: crypto.randomUUID(),
      projectId: floor.projectId,
      floorId: floor.id,
      roomId: room?.id ?? entity?.roomIds[0] ?? null,
      elementId: entity?.id ?? null,
      position,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });
    setError("");
  }
  useEffect(() => {
    if (!point) return;
    queueMicrotask(() => {
      base.current = null;
      const now = new Date().toISOString();
      setDraft({
        ...defaults,
        id: crypto.randomUUID(),
        projectId: floor.projectId,
        floorId: floor.id,
        roomId: null,
        elementId: null,
        position: point,
        revision: 0,
        createdAt: now,
        updatedAt: now,
      });
      setBoundary("");
      onPointUsed();
    });
  }, [point, floor.id, floor.projectId, onPointUsed]);
  function edit(d: Defect) {
    base.current = d.revision;
    setDraft(d);
    setBoundary(d.boundary.map((p) => `${p.x} ${p.y}`).join("\n"));
    setError("");
  }
  async function action(fn: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Не удалось сохранить. Проверьте место на устройстве.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    await action(async () => {
      if (!(await flushEditors()))
        throw new Error("Сначала сохраните или восстановите план");
      const points = boundary.trim()
        ? boundary
            .trim()
            .split(/\n/)
            .map((line) => {
              const v = line.trim().split(/\s+/);
              if (v.length !== 2)
                throw new Error("Точки области: по одной паре x y в строке");
              return {
                x: Number(v[0].replace(",", ".")),
                y: Number(v[1].replace(",", ".")),
              };
            })
        : [];
      const fields = new FormData(e.target as HTMLFormElement);
      const sizes = Object.fromEntries(
        ["length", "width", "depth"].map((key) => {
          const v = String(fields.get(key) ?? "").trim();
          return [key, v ? parseLengthInput(v) : null];
        }),
      );
      const saved = await media.saveDefect(
        { ...draft, ...sizes, boundary: points },
        base.current,
      );
      base.current = saved.revision;
      setDraft(saved);
    });
  }
  async function upload(
    files: FileList | null,
    binding: Binding & { defectId: string | null },
  ) {
    if (!files?.length) return;
    const selectedFiles = Array.from(files);
    await action(async () => {
      if (!(await flushEditors())) throw new Error("Сначала сохраните план");
      let count = 0;
      for (const file of selectedFiles) {
        try {
          await media.addPhoto(file, binding, caption);
          count++;
        } catch (e) {
          throw new Error(
            `Сохранено ${count} из ${selectedFiles.length}. ${e instanceof Error ? e.message : "Ошибка файла"}`,
            { cause: e },
          );
        }
      }
    });
  }
  const selected = draft
    ? data.defects.find((d) => d.id === draft.id)
    : undefined;
  const standalone: Binding & { defectId: null } = {
    projectId: floor.projectId,
    floorId: scope === "project" ? null : floor.id,
    roomId: scope.startsWith("room:") ? scope.slice(5) : null,
    elementId: scope.startsWith("element:") ? scope.slice(8) : null,
    defectId: null,
  };
  const quantities = draft ? defectQuantities(draft) : null;
  return (
    <section className="media-panel" aria-label="Дефекты и фотографии">
      <h2>Дефекты и фотографии</h2>
      <p className="muted">
        Оригиналы сохраняются отдельно на устройстве. Превью уменьшено; корзина
        сохраняет исходник.
      </p>
      <div className="media-actions">
        <button disabled={busy} onClick={() => fresh()}>
          + Добавить дефект
        </button>
        <button aria-pressed={trash} onClick={() => setTrash(!trash)}>
          {trash ? "Показать активные" : "Корзина дефектов и фото"}
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="defect-list">
        {!records.length && (
          <p className="muted">
            {trash ? "Корзина дефектов пуста" : "На этом этаже нет дефектов"}
          </p>
        )}
        <PagedList
          items={records}
          label="Дефекты"
          key={`defects-${floor.id}-${trash}`}
          render={(d) => (
            <article key={d.id} data-testid="defect-card">
              <h3>{d.type}</h3>
              <p>{d.description}</p>
              <small>
                {d.status === "open" ? "Открыт" : "Устранён"} ·{" "}
                {d.surface || "Поверхность не указана"}
              </small>
              {d.elementId &&
                ![...scene.walls, ...(scene.elements ?? [])].some(
                  (e) => e.id === d.elementId,
                ) && (
                  <p className="error">
                    Связанный элемент удалён; дефект сохранён
                  </p>
                )}
              <button disabled={busy} onClick={() => edit(d)}>
                Открыть дефект
              </button>
              {d.position && (
                <button
                  onClick={() =>
                    store.setState({
                      focusRequest: {
                        points: [d.position!],
                        serial:
                          (store.getState().focusRequest?.serial ?? 0) + 1,
                      },
                    })
                  }
                >
                  Показать дефект на плане
                </button>
              )}
              <button
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await media.saveDefect(
                      {
                        ...d,
                        deletedAt: d.deletedAt
                          ? null
                          : new Date().toISOString(),
                      },
                      d.revision,
                    );
                    if (draft?.id === d.id) setDraft(null);
                  })
                }
              >
                {d.deletedAt ? "Восстановить дефект" : "В корзину дефект"}
              </button>
            </article>
          )}
        />
      </div>
      {draft && (
        <form
          ref={formRef}
          className="defect-form"
          onSubmit={(e) => void save(e)}
        >
          <h3>{selected ? "Свойства дефекта" : "Новый дефект"}</h3>
          <label>
            Тип дефекта
            <input
              required
              maxLength={80}
              list="defect-types"
              value={draft.type}
              onChange={(e) => setDraft({ ...draft, type: e.target.value })}
            />
          </label>
          <datalist id="defect-types">
            <option>Трещина</option>
            <option>Отслоение</option>
            <option>Протечка</option>
            <option>Коррозия</option>
            <option>Неровность</option>
          </datalist>
          <label>
            Описание дефекта
            <textarea
              required
              maxLength={4000}
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
            />
          </label>
          <label>
            Помещение дефекта
            <select
              value={draft.roomId ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, roomId: e.target.value || null })
              }
            >
              <option value="">Без помещения</option>
              {scene.rooms?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name || "Без названия"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Элемент дефекта
            <select
              value={draft.elementId ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, elementId: e.target.value || null })
              }
            >
              <option value="">Без элемента</option>
              {[...scene.walls, ...(scene.elements ?? [])].map((el, i) => (
                <option key={el.id} value={el.id}>
                  {el.kind} №{i + 1}
                </option>
              ))}
            </select>
          </label>
          <label>
            Поверхность
            <input
              maxLength={80}
              value={draft.surface}
              onChange={(e) => setDraft({ ...draft, surface: e.target.value })}
            />
          </label>
          <div className="media-grid">
            {(["length", "width", "depth"] as const).map((key, i) => (
              <label key={key}>
                {
                  [
                    "Длина дефекта, м",
                    "Ширина дефекта, м",
                    "Глубина дефекта, м",
                  ][i]
                }
                <input
                  inputMode="decimal"
                  name={key}
                  key={`${draft.id}-${draft.revision}-${key}`}
                  defaultValue={draft[key] ?? ""}
                  onBlur={(e) => {
                    try {
                      setDraft({
                        ...draft,
                        [key]: e.target.value.trim()
                          ? parseLengthInput(e.target.value)
                          : null,
                      });
                    } catch {
                      setError("Введите положительный размер в метрах");
                    }
                  }}
                />
              </label>
            ))}
          </div>
          <p>
            Площадь: {quantities?.area?.toLocaleString("ru-RU") ?? "не задана"}{" "}
            м² · Объём:{" "}
            {quantities?.volume?.toLocaleString("ru-RU") ?? "не задан"} м³
          </p>
          <div className="media-grid">
            {(["x", "y"] as const).map((key) => (
              <label key={key}>
                Положение {key}, м
                <input
                  inputMode="decimal"
                  value={draft.position?.[key] ?? ""}
                  onChange={(e) => {
                    const n = Number(e.target.value.replace(",", "."));
                    if (Number.isFinite(n))
                      setDraft({
                        ...draft,
                        position: {
                          ...(draft.position ?? { x: 0, y: 0 }),
                          [key]: n,
                        },
                      });
                  }}
                />
              </label>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setDraft({ ...draft, position: null })}
          >
            Убрать положение
          </button>
          <label>
            Область дефекта: x y на каждой строке
            <textarea
              value={boundary}
              placeholder="0 0&#10;1 0&#10;1 1"
              onChange={(e) => setBoundary(e.target.value)}
            />
          </label>
          <label>
            Комментарий
            <textarea
              maxLength={4000}
              value={draft.comment}
              onChange={(e) => setDraft({ ...draft, comment: e.target.value })}
            />
          </label>
          <label>
            Рекомендуемый вид работ
            <input
              maxLength={500}
              value={draft.recommendedWork}
              onChange={(e) =>
                setDraft({ ...draft, recommendedWork: e.target.value })
              }
            />
          </label>
          <label>
            Статус дефекта
            <select
              value={draft.status}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  status: e.target.value as Defect["status"],
                })
              }
            >
              <option value="open">Открыт</option>
              <option value="resolved">Устранён</option>
            </select>
          </label>
          <button className="primary" disabled={busy}>
            Сохранить дефект
          </button>
          <button type="button" onClick={() => setDraft(null)}>
            Закрыть свойства дефекта
          </button>
        </form>
      )}
      <label>
        Подпись новых фото
        <input
          maxLength={1000}
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
        />
      </label>
      {selected && !selected.deletedAt && (
        <label>
          Добавить фото к дефекту
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            multiple
            disabled={busy}
            onChange={(e) => {
              void upload(e.target.files, {
                projectId: selected.projectId,
                floorId: selected.floorId,
                roomId: selected.roomId,
                elementId: selected.elementId,
                defectId: selected.id,
              });
              e.target.value = "";
            }}
          />
        </label>
      )}
      <label>
        Привязка отдельного фото
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="project">Объект</option>
          <option value="floor">Этот этаж</option>
          {scene.rooms?.map((r) => (
            <option key={r.id} value={`room:${r.id}`}>
              Помещение: {r.name || "Без названия"}
            </option>
          ))}
          {[...scene.walls, ...(scene.elements ?? [])].map((e, i) => (
            <option key={e.id} value={`element:${e.id}`}>
              Элемент: {e.kind} №{i + 1}
            </option>
          ))}
        </select>
      </label>
      <label>
        Добавить отдельные фото
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          multiple
          disabled={busy}
          onChange={(e) => {
            void upload(e.target.files, standalone);
            e.target.value = "";
          }}
        />
      </label>
      <label>
        Снять фото
        <input
          type="file"
          accept="image/*"
          capture="environment"
          disabled={busy}
          onChange={(e) => {
            void upload(
              e.target.files,
              selected
                ? {
                    projectId: selected.projectId,
                    floorId: selected.floorId,
                    roomId: selected.roomId,
                    elementId: selected.elementId,
                    defectId: selected.id,
                  }
                : standalone,
            );
            e.target.value = "";
          }}
        />
      </label>
      {busy && <p role="status">Сохраняем файлы по очереди…</p>}
      <PagedList
        key={`photos-${floor.id}-${trash}-${selected?.id ?? "all"}`}
        label="Фотографии"
        className="photo-grid"
        items={data.photos.filter(
          (p) =>
            (p.floorId === floor.id || p.floorId === null) &&
            !!p.deletedAt === trash &&
            (!selected || p.defectId === selected.id),
        )}
        render={(p) => (
          <PhotoCard
            photo={p}
            refresh={refresh}
            onChange={() => setRefresh((n) => n + 1)}
          />
        )}
      />
    </section>
  );
}
