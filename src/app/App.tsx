import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { Projects } from "../features/projects/Projects";
import { WorkspaceRoute } from "../features/projects/Workspace";

const CloudPanel = lazy(() =>
  import("../features/cloud/CloudPanel").then((m) => ({
    default: m.CloudPanel,
  })),
);
function useConnection() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}
export function App() {
  const online = useConnection();
  const [owner, setOwner] = useState<string | null>(null);
  const onOwner = useCallback((id: string | null) => setOwner(id), []);
  return (
    <>
      <header className="topbar">
        <Link className="brand" to="/">
          ▧ <span>Замер</span>
          <small>Цифровой объект</small>
        </Link>
        <span className="connection">
          {online ? "На устройстве" : "Офлайн · на устройстве"}
        </span>
      </header>
      <div className="guest">
        {owner
          ? "Локальная копия доступна без сети. Статус облачного сохранения показан в аккаунте."
          : "Гостевой режим · проекты хранятся только в этом браузере и не сохранены в облаке."}
      </div>
      <Suspense fallback={null}>
        <CloudPanel onOwner={onOwner} />
      </Suspense>
      <Routes key={owner ?? "guest"}>
        <Route path="/" element={<Projects />} />
        <Route
          path="/projects/:projectId/floors/:floorId"
          element={<WorkspaceRoute />}
        />
        <Route
          path="*"
          element={
            <main>
              <h1>Страница не найдена</h1>
              <Link to="/">К проектам</Link>
            </main>
          }
        />
      </Routes>
    </>
  );
}
