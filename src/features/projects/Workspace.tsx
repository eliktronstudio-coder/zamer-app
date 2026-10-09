import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { repository } from "../../infrastructure/database";
import type { Floor, Project } from "../../domain/model";
const Editor = lazy(() =>
  import("../../editor/Editor").then((module) => ({ default: module.Editor })),
);
const ExportPanel = lazy(() =>
  import("../export/ExportPanel").then((m) => ({ default: m.ExportPanel })),
);
const DocumentPanel = lazy(() =>
  import("../documents/DocumentPanel").then((module) => ({
    default: module.DocumentPanel,
  })),
);
const ProjectQuantities = lazy(() =>
  import("./ProjectQuantities").then((module) => ({
    default: module.ProjectQuantities,
  })),
);
import { saveError } from "../../app/messages";
export function WorkspaceRoute() {
  const { projectId } = useParams();
  return <Workspace key={projectId} />;
}
function Workspace() {
  const { projectId, floorId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project>();
  const [floors, setFloors] = useState<Floor[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [showDocuments, setShowDocuments] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    let active = true;
    Promise.all([repository.get(projectId!), repository.floors(projectId!)])
      .then(([p, rows]) => {
        if (active) {
          setProject(p);
          setFloors(rows);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (active)
          setError("Не удалось открыть объект из локального хранилища.");
      });
    return () => {
      active = false;
    };
  }, [projectId]);
  const floor = floors.find((f) => f.id === floorId);
  async function add(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const next = await repository.addFloor(projectId!, name);
      setFloors(await repository.floors(projectId!));
      setAdding(false);
      setName("");
      navigate(`/projects/${projectId}/floors/${next.id}`);
    } catch {
      setError(saveError);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  if (!loaded)
    return (
      <main>
        {error ? <p role="alert">{error}</p> : <p>Открываем объект…</p>}
        <Link to="/">К проектам</Link>
      </main>
    );
  if (!project || !floor || project.status !== "active")
    return (
      <main>
        <h1>Объект или этаж недоступен</h1>
        <Link to="/">К проектам и восстановлению</Link>
      </main>
    );
  return (
    <div className="workspace">
      <aside>
        <Link to="/">← Мои объекты</Link>
        <h2>{project.name}</h2>
        <p className="eyebrow">ЭТАЖИ</p>
        <nav aria-label="Этажи">
          {floors.map((f) => (
            <Link
              className={f.id === floorId ? "floor selected" : "floor"}
              aria-current={f.id === floorId ? "page" : undefined}
              key={f.id}
              to={`/projects/${projectId}/floors/${f.id}`}
            >
              ▧ {f.name}
            </Link>
          ))}
        </nav>
        <button onClick={() => setAdding(!adding)}>+ Добавить этаж</button>
        {adding && (
          <form onSubmit={add}>
            <label>
              Название этажа
              <input
                autoFocus
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <button className="primary" disabled={busy || !name.trim()}>
              Добавить
            </button>
          </form>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <Suspense fallback={<p>Считаем итоги…</p>}>
          <ProjectQuantities key={projectId} projectId={projectId!} />
        </Suspense>
        <div className="local-note">
          <small>
            Локальное сохранение работает без сети. Подключение и статус облака
            — в аккаунте.
          </small>
        </div>
      </aside>
      <section className="plan">
        <div className="plan-heading">
          <div>
            <p className="eyebrow">ПЛАН ОБЪЕКТА</p>
            <h1>{floor.name}</h1>
          </div>
        </div>
        <button
          aria-expanded={showDocuments}
          onClick={() => setShowDocuments(!showDocuments)}
        >
          Ведомости и документы
        </button>
        {showDocuments && (
          <Suspense fallback={<p>Открываем документы…</p>}>
            <DocumentPanel
              key={projectId}
              projectId={projectId!}
              currentFloorId={floor.id}
            />
          </Suspense>
        )}
        <button
          aria-expanded={showExport}
          onClick={() => setShowExport(!showExport)}
        >
          Экспорт всего проекта
        </button>
        {showExport && (
          <Suspense fallback={<p>Открываем экспорт…</p>}>
            <ExportPanel key={projectId} projectId={projectId!} />
          </Suspense>
        )}
        <Suspense fallback={<p role="status">Открываем редактор…</p>}>
          <Editor
            key={floor.id}
            floor={floor}
            onRecovered={async (recovered) => {
              setFloors(await repository.floors(projectId!));
              navigate(`/projects/${projectId}/floors/${recovered.id}`);
            }}
          />
        </Suspense>
        <footer>
          Метры · высота по умолчанию{" "}
          {floor.defaultHeight.toLocaleString("ru-RU")} м{" "}
          <span>Данные на устройстве</span>
        </footer>
      </section>
    </div>
  );
}
