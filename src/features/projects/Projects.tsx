import { liveQuery } from "dexie";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { repository } from "../../infrastructure/database";
import type { Project } from "../../domain/model";
import { saveError } from "../../app/messages";
const ImportPanel = lazy(() =>
  import("../export/ImportPanel").then((m) => ({ default: m.ImportPanel })),
);
export function Projects() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [floorName, setFloorName] = useState("Этаж 1");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Project["status"]>("active");
  const [sort, setSort] = useState("date");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [busy, setBusy] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const pending = useRef(false);
  async function load() {
    try {
      setProjects(await repository.list());
      setLoaded(true);
    } catch {
      setError(
        "Не удалось открыть локальное хранилище. Разрешите хранение данных для этого сайта.",
      );
    }
  }
  useEffect(() => {
    const subscription = liveQuery(() => repository.list()).subscribe({
      next: (rows) => {
        setProjects(rows);
        setLoaded(true);
      },
      error: () => setError("Не удалось открыть локальное хранилище."),
    });
    return () => subscription.unsubscribe();
  }, []);
  async function perform(action: () => Promise<unknown>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
    } catch {
      setError(saveError);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    await perform(async () => {
      const { project, floor } = await repository.create(name, floorName);
      navigate(`/projects/${project.id}/floors/${floor.id}`);
    });
  }
  async function open(project: Project) {
    await perform(async () => {
      const floors = await repository.floors(project.id);
      if (!floors.length) throw new Error("Нет этажа");
      navigate(`/projects/${project.id}/floors/${floors[0].id}`);
    });
  }
  const visible = projects
    .filter(
      (p) =>
        p.status === status &&
        p.name.toLocaleLowerCase("ru").includes(query.toLocaleLowerCase("ru")),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name, "ru")
        : b.updatedAt.localeCompare(a.updatedAt),
    );
  return (
    <main>
      <div className="page-heading">
        <div>
          <p className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</p>
          <h1>Мои объекты</h1>
          <p className="muted">От первого замера к единой цифровой модели.</p>
        </div>
        <button className="primary" onClick={() => setCreating(!creating)}>
          + Новый объект
        </button>
      </div>
      <button
        aria-expanded={showImport}
        onClick={() => setShowImport(!showImport)}
      >
        Импортировать проект
      </button>
      {showImport && (
        <Suspense fallback={<p>Открываем импорт…</p>}>
          <ImportPanel />
        </Suspense>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {creating && (
        <form className="create-form" onSubmit={create}>
          <h2>Новый объект</h2>
          <label>
            Название объекта
            <input
              autoFocus
              required
              maxLength={160}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Например, офис на Ленина"
            />
          </label>
          <label>
            Первый этаж
            <input
              required
              maxLength={80}
              value={floorName}
              onChange={(e) => setFloorName(e.target.value)}
            />
          </label>
          <div className="actions">
            <button
              className="primary"
              disabled={busy || !name.trim() || !floorName.trim()}
            >
              Создать и открыть план
            </button>
            <button type="button" onClick={() => setCreating(false)}>
              Отмена
            </button>
          </div>
        </form>
      )}
      <div className="filters">
        <div className="tabs" role="group" aria-label="Состояние проектов">
          {(["active", "archived", "trashed"] as const).map((s, i) => (
            <button
              key={s}
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
            >
              {["Активные", "Архив", "Корзина"][i]}{" "}
              <small>{projects.filter((p) => p.status === s).length}</small>
            </button>
          ))}
        </div>
        <label className="search">
          Поиск
          <input
            aria-label="Поиск по названию"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Название объекта"
          />
        </label>
        <label>
          Сортировка
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="date">Сначала недавние</option>
            <option value="name">По названию</option>
          </select>
        </label>
      </div>
      {!loaded && !error && <p role="status">Открываем локальные проекты…</p>}
      {loaded && visible.length === 0 && (
        <section className="empty">
          <span className="empty-icon">▧</span>
          <h2>
            {query
              ? "Объекты не найдены"
              : status === "active"
                ? "Ваш первый замер начинается здесь"
                : "Здесь пока пусто"}
          </h2>
          <p>
            {query
              ? "Попробуйте другое название."
              : "Создайте объект и этаж. Рабочий лист будет пустым — без демонстрационных элементов."}
          </p>
        </section>
      )}
      <div className="project-grid">
        {visible.map((p) => (
          <article className="project-card" key={p.id}>
            <div className="card-icon">▧</div>
            {renameId === p.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void perform(async () => {
                    await repository.rename(p.id, renameName);
                    setRenameId(null);
                  });
                }}
              >
                <label>
                  Новое название
                  <input
                    autoFocus
                    required
                    maxLength={160}
                    value={renameName}
                    onChange={(e) => setRenameName(e.target.value)}
                  />
                </label>
                <div className="actions">
                  <button disabled={busy || !renameName.trim()}>
                    Применить
                  </button>
                  <button type="button" onClick={() => setRenameId(null)}>
                    Отмена
                  </button>
                </div>
              </form>
            ) : (
              <h2>{p.name}</h2>
            )}
            <p className="muted">
              Изменён{" "}
              {new Intl.DateTimeFormat("ru-RU").format(new Date(p.updatedAt))}
            </p>
            <div className="card-actions">
              {p.status === "active" && (
                <>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => void open(p)}
                  >
                    Открыть план →
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setRenameId(p.id);
                      setRenameName(p.name);
                    }}
                  >
                    Переименовать
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(() => repository.status(p.id, "archived"))
                    }
                  >
                    В архив
                  </button>
                </>
              )}
              {p.status !== "active" && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void perform(() => repository.status(p.id, "active"))
                  }
                >
                  Восстановить
                </button>
              )}
              {p.status !== "trashed" && (
                <button
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Переместить «${p.name}» в корзину? Связанные данные сохранятся.`,
                      )
                    )
                      void perform(() => repository.status(p.id, "trashed"));
                  }}
                >
                  В корзину
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      <p className="phase-note">
        Проекты и планы автоматически сохраняются в этом браузере.
      </p>
    </main>
  );
}
