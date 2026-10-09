import { lazy, Suspense } from "react";
import { sourcePoints } from "../features/three/source-points";
const ThreeViewer = lazy(() =>
  import("../features/three/ThreeViewer").then((m) => ({
    default: m.ThreeViewer,
  })),
);
import { MediaPanel } from "../features/media/MediaPanel";
import type { Point } from "../domain/model";
import { registerEditorFlush } from "./flush-editors";
import { IssuesPanel } from "./IssuesPanel";
import { CalculationPanel } from "./CalculationPanel";
import { toolNames, isConstructionTool } from "./element-commands";
import { openingProblems } from "../geometry/elements";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { Floor } from "../domain/model";
import { sceneRepository } from "../infrastructure/database";
import { createEditorStore, type EditorStore } from "./store";
import { SaveQueue, type SaveNotification } from "./save-queue";
import { Canvas } from "./Canvas";
import { Properties } from "./Properties";
import type { RecoveryDraft } from "../infrastructure/scene-storage";
export function Editor({
  floor,
  onRecovered,
}: {
  floor: Floor;
  onRecovered: (floor: Floor) => Promise<void>;
}) {
  const [loaded, setLoaded] = useState<{
    store: EditorStore;
    revision: number;
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    sceneRepository
      .load(floor.id)
      .then((data) => {
        if (active)
          setLoaded({
            store: createEditorStore(floor.id, data.scene, floor.defaultHeight),
            revision: data.revision,
          });
      })
      .catch(() => {
        if (active)
          setError(
            "Не удалось открыть план. Исходные данные сохранены; попробуйте перезагрузить страницу.",
          );
      });
    return () => {
      active = false;
    };
  }, [floor.id, floor.defaultHeight]);
  if (error)
    return (
      <p role="alert" className="error">
        {error}
      </p>
    );
  if (!loaded) return <p role="status">Открываем план…</p>;
  return (
    <EditorReady
      store={loaded.store}
      revision={loaded.revision}
      floor={floor}
      onRecovered={onRecovered}
    />
  );
}
function EditorReady({
  store,
  revision,
  floor,
  onRecovered,
}: {
  store: EditorStore;
  revision: number;
  floor: Floor;
  onRecovered: (floor: Floor) => Promise<void>;
}) {
  const state = useStore(store);
  const [view, setView] = useState<"2d" | "3d">("2d");
  const [defectPoint, setDefectPoint] = useState<Point | null>(null);
  const clearDefectPoint = useCallback(() => setDefectPoint(null), []);
  const [saving, setSaving] = useState<SaveNotification>({
    status: "saved",
    backupAvailable: false,
  });
  const [drafts, setDrafts] = useState<RecoveryDraft[]>([]);
  const [recoverError, setRecoverError] = useState("");
  const queueRef = useRef<SaveQueue | null>(null);
  const [help, setHelp] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const recoveryBusy = useRef(false);
  const sessionRef = useRef("");
  useEffect(() => {
    let active = true;
    const sessionId = crypto.randomUUID();
    sessionRef.current = sessionId;
    let lastNotification: SaveNotification = {
      status: "saved",
      backupAvailable: false,
    };
    const queue = new SaveQueue(revision, {
      save: async (scene, expected) => {
        const next = await sceneRepository.save(
          floor.id,
          scene,
          expected,
          sessionId,
        );
        if (active)
          setDrafts((rows) => rows.filter((row) => row.id !== sessionId));
        return next;
      },
      backup: async (scene) => {
        await sceneRepository.backup(sessionId, floor.id, scene);
        if (active) setDrafts(await sceneRepository.drafts(floor.id));
      },
      notify: (value) => {
        lastNotification = value;
        if (active) setSaving(value);
      },
    });
    queueRef.current = queue;
    sceneRepository
      .drafts(floor.id)
      .then((rows) => {
        if (active) setDrafts(rows);
      })
      .catch(() => {});
    const unsubscribe = store.subscribe((next, previous) => {
      if (next.changeId !== previous.changeId) queue.schedule(next.scene);
    });
    const unregisterFlush = registerEditorFlush(async () => {
      await queue.flush();
      return !queue.dirty || lastNotification.backupAvailable;
    });
    const flush = () => void queue.flush();
    const visibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (queue.dirty && !lastNotification.backupAvailable) {
        event.preventDefault();
        event.returnValue = "";
        flush();
      }
    };
    // Internal navigation waits for the queue too, including floor changes.
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", flush);
    // Navigation is handled via a one-shot bypass below to avoid replay recursion.
    let bypass = false;
    const navigation = (event: MouseEvent) => {
      if (bypass) {
        bypass = false;
        return;
      }
      const target =
        event.target instanceof Element ? event.target.closest("a") : null;
      if (
        !target ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.button !== 0 ||
        !queue.dirty
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      void queue.flush().then(() => {
        if (
          queue.dirty &&
          !lastNotification.backupAvailable &&
          !window.confirm(
            "Не удалось сохранить изменения или резервную копию. Покинуть страницу и потерять текущие изменения?",
          )
        )
          return;
        bypass = true;
        target.click();
      });
    };
    document.addEventListener("click", navigation, true);
    const keydown = (event: KeyboardEvent) => {
      if (recoveryBusy.current) return;
      if (event.key === "Escape") {
        store.getState().cancel();
        return;
      }
      const target = event.target as HTMLElement;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      )
        return;
      const current = store.getState();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) current.redo();
        else current.undo();
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "y"
      ) {
        event.preventDefault();
        current.redo();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        current.remove();
      } else if (event.key === "Escape") current.cancel();
    };
    window.addEventListener("keydown", keydown);
    return () => {
      active = false;
      unsubscribe();
      document.removeEventListener("click", navigation, true);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("keydown", keydown);
      unregisterFlush();
      void queue.flush();
    };
  }, [store, revision, floor.id]);
  async function recover(id: string) {
    if (recoveryBusy.current) return;
    recoveryBusy.current = true;
    setRecovering(true);
    const source = store.getState().scene;
    try {
      await queueRef.current?.flush();
      const next = await sceneRepository.recover(id);
      if (id === sessionRef.current) queueRef.current?.acknowledgeScene(source);
      await onRecovered(next);
    } catch {
      setRecoverError(
        "Не удалось восстановить копию. Она остаётся в локальном хранилище.",
      );
    } finally {
      recoveryBusy.current = false;
      setRecovering(false);
    }
  }
  const status =
    saving.status === "saved"
      ? "Сохранено на устройстве"
      : saving.status === "pending"
        ? "Есть изменения · сохраняем…"
        : saving.status === "saving"
          ? "Сохраняем…"
          : saving.status === "conflict"
            ? "План изменён в другой вкладке"
            : "Не удалось сохранить план";
  return (
    <div className="editor-session" inert={recovering}>
      <div className="view-switch">
        <button aria-pressed={view === "2d"} onClick={() => setView("2d")}>
          2D план
        </button>
        <button aria-pressed={view === "3d"} onClick={() => setView("3d")}>
          3D вид
        </button>
      </div>
      <div className="editor">
        {view === "2d" && (
          <>
            {" "}
            <div
              className="editor-toolbar"
              role="toolbar"
              aria-label="Инструменты плана"
            >
              {(
                [
                  ["select", "Выбор"],
                  ["hand", "Рука"],
                  ["wall", "Стена"],
                  ["dimension", "Размер"],
                  ["room", "Помещение"],
                  ["defect", "Дефект"],
                ] as const
              ).map(([tool, label]) => (
                <button
                  key={tool}
                  aria-pressed={state.tool === tool}
                  onClick={() => state.setTool(tool)}
                >
                  {label}
                </button>
              ))}
              <label className="construction-tools">
                Конструкции
                <select
                  aria-label="Строительный инструмент"
                  value={isConstructionTool(state.tool) ? state.tool : ""}
                  onChange={(event) => {
                    if (isConstructionTool(event.target.value))
                      state.setTool(event.target.value);
                  }}
                >
                  <option value="" disabled>
                    Выберите элемент
                  </option>
                  {Object.entries(toolNames).map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                aria-pressed={state.orthogonal}
                onClick={() =>
                  store.setState({ orthogonal: !state.orthogonal })
                }
              >
                Ортогонально
              </button>
              <button
                aria-pressed={state.snaps}
                onClick={() => store.setState({ snaps: !state.snaps })}
              >
                Привязки
              </button>
              <button
                aria-label="Отменить"
                disabled={!state.past.length}
                onClick={state.undo}
              >
                ↶
              </button>
              <button
                aria-label="Повторить"
                disabled={!state.future.length}
                onClick={state.redo}
              >
                ↷
              </button>
              <button
                aria-label="Инструкция по управлению"
                onClick={() => setHelp(!help)}
              >
                ?
              </button>
            </div>
            <div
              className="editor-status"
              role="status"
              data-save-status={saving.status}
            >
              {status} · {state.scene.walls.length} стен ·{" "}
              {state.scene.elements?.length ?? 0} конструкций
            </div>
            {(state.scene.elements ?? []).flatMap((e) =>
              e.kind === "opening"
                ? openingProblems(
                    e,
                    state.scene.walls,
                    state.scene.elements,
                  ).map((message) => (
                    <p
                      role="alert"
                      className="error"
                      key={`${e.id}:${message}`}
                    >
                      {toolNames[e.type]}: {message}. Размеры сохранены;
                      выберите элемент, чтобы исправить параметры.
                    </p>
                  ))
                : [],
            )}
            {(saving.status === "error" || saving.status === "conflict") && (
              <p role="alert" className="error">
                {saving.status === "conflict"
                  ? "Другая вкладка сохранила более новую версию. Она не перезаписана."
                  : "Проверьте свободное место и разрешение на хранение данных."}{" "}
                {saving.backupAvailable
                  ? "Ваша версия сохранена отдельной локальной копией."
                  : "Текущие изменения ещё не подтверждены хранилищем. Не закрывайте страницу."}
                {saving.status === "error" && (
                  <button onClick={() => void queueRef.current?.retry()}>
                    Повторить сохранение
                  </button>
                )}
              </p>
            )}
            {drafts.map((draft) => (
              <div className="recovery" key={draft.id}>
                Есть локальная копия после ошибки сохранения.{" "}
                <button onClick={() => void recover(draft.id)}>
                  Восстановить копию на новом этаже
                </button>
              </div>
            ))}
            {recoverError && (
              <p role="alert" className="error">
                {recoverError}
              </p>
            )}
            {help && (
              <div className="editor-help">
                <strong>Управление планом</strong>
                <p>
                  Конструкции: выберите тип в списке, задайте параметры и
                  укажите положение на плане. Окна, двери и проёмы размещаются
                  на стене; балка — двумя точками; граница уровня завершается
                  кнопкой.
                </p>
                <p>
                  Стена: укажите начало и направление, введите длину в метрах и
                  нажмите Enter. Следующая стена начинается из конца предыдущей.
                  Esc завершает цепочку.
                </p>
                <p>
                  Выбор: нажмите стену или размер. Перетаскивайте уже выбранную
                  стену. Движение по пустому месту перемещает лист; колесо и два
                  пальца меняют масштаб.
                </p>
                <p>
                  Ctrl/⌘+Z — отменить; Ctrl+Y или Ctrl/⌘+Shift+Z — повторить;
                  Delete — удалить. Геометрия не меняется при случайном движении
                  менее 5 пикселей.
                </p>
              </div>
            )}
            {state.message && (
              <p className="error" role="alert">
                {state.message}
              </p>
            )}
          </>
        )}
        {view === "3d" ? (
          <Suspense fallback={<p role="status">Строим 3D…</p>}>
            <ThreeViewer
              scene={state.scene}
              floor={floor}
              onSelect={(id) => {
                setView("2d");
                store.getState().setTool("select");
                store.getState().select(id);
                store.setState({
                  focusRequest: {
                    points: sourcePoints(state.scene, id),
                    serial: (store.getState().focusRequest?.serial ?? 0) + 1,
                  },
                });
              }}
            />
          </Suspense>
        ) : (
          <div className="editor-body">
            <Canvas
              store={store}
              floorId={floor.id}
              onDefectPoint={(p) => {
                setDefectPoint(p);
                store.getState().setTool("select");
              }}
            />
            <Properties store={store} />
          </div>
        )}
        <IssuesPanel store={store} floor={floor} saving={saving} />
        <CalculationPanel store={store} />
      </div>
      <MediaPanel
        store={store}
        floor={floor}
        point={defectPoint}
        onPointUsed={clearDefectPoint}
      />
    </div>
  );
}
