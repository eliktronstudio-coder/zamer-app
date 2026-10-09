import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { liveQuery } from "dexie";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import {
  configuredClient,
  SupabaseTransport,
} from "../../infrastructure/supabase-transport";
import { CloudRepository } from "../../infrastructure/cloud-repository";
import { SyncWorker } from "../../infrastructure/sync-worker";
import { repository } from "../../infrastructure/database";
import { flushEditors } from "../../editor/flush-editors";
import type { Project } from "../../domain/model";
import type {
  CloudState,
  CloudConflict,
  OutboxEntry,
} from "../../infrastructure/sync-model";
function clientConfig(): { client: SupabaseClient | null; error: string } {
  try {
    return { client: configuredClient(), error: "" };
  } catch {
    return {
      client: null,
      error: "Проверьте публичную конфигурацию Supabase.",
    };
  }
}
const sharedConfig = clientConfig();
export function CloudPanel({
  onOwner,
}: {
  onOwner: (id: string | null) => void;
}) {
  const config = sharedConfig,
    client = config.client,
    cloud = useMemo(() => new CloudRepository(repository.db), []);
  const [user, setUser] = useState<User | null>(null),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(config.error),
    [mode, setMode] = useState<"login" | "signup" | "reset" | "recovery">(
      "login",
    );
  const [data, setData] = useState<{
    projects: Project[];
    states: CloudState[];
    conflicts: CloudConflict[];
    outbox: OutboxEntry[];
  }>({ projects: [], states: [], conflicts: [], outbox: [] });
  const worker = useRef<SyncWorker | null>(null),
    owner = useRef<string | null>(null),
    location = useLocation(),
    navigate = useNavigate();
  const root = location.pathname === "/",
    projectId = location.pathname.split("/")[2];
  useEffect(() => {
    if (!client) return;
    let active = true;
    let generation = 0;
    async function session(next: User | null, recovery = false) {
      const token = ++generation;
      worker.current?.stop();
      worker.current = null;
      const flushed = await flushEditors();
      if (!active || token !== generation) return;
      repository.db.currentOwnerId = next?.id ?? null;
      owner.current = next?.id ?? null;
      setUser(next);
      onOwner(next?.id ?? null);
      if (recovery) {
        setMode("recovery");
        setOpen(true);
      }
      if (!flushed)
        setMessage(
          "Не все изменения удалось подтвердить локально. Проверьте резервные копии при возвращении в аккаунт.",
        );
      if (next) {
        const nextWorker = new SyncWorker(
          cloud,
          next.id,
          new SupabaseTransport(client!, repository.db),
        );
        worker.current = nextWorker;
        void nextWorker
          .run()
          .catch(() =>
            setMessage("Синхронизация недоступна; локальные данные сохранены."),
          );
      }
    }
    void client.auth.getSession().then(({ data, error }) => {
      if (error && active)
        setMessage("Не удалось проверить аккаунт. Гостевой замер доступен.");
      if (active) void session(data.session?.user ?? null);
    });
    const { data: listener } = client.auth.onAuthStateChange(
      (event, sessionData) => {
        queueMicrotask(() => {
          if (active)
            void session(
              sessionData?.user ?? null,
              event === "PASSWORD_RECOVERY",
            );
        });
      },
    );
    return () => {
      active = false;
      generation++;
      listener.subscription.unsubscribe();
      worker.current?.stop();
    };
  }, [client, cloud, onOwner]);
  useEffect(() => {
    const db = repository.db;
    const subscription = liveQuery(async () => ({
      projects: await repository.list(),
      states: await db.cloudStates.where({ ownerId: user?.id ?? "" }).toArray(),
      conflicts: await db.cloudConflicts
        .where({ ownerId: user?.id ?? "" })
        .toArray(),
      outbox: await db.outbox.where({ ownerId: user?.id ?? "" }).toArray(),
    })).subscribe({
      next: setData,
      error: () =>
        setMessage("Не удалось прочитать состояние локальной очереди."),
    });
    return () => subscription.unsubscribe();
  }, [user?.id]);
  useEffect(() => {
    if (!user) return;
    let active = true;
    const run = () => {
      if (active && navigator.onLine)
        void worker.current
          ?.run()
          .catch(() =>
            setMessage("Синхронизация недоступна; попробуйте позже."),
          );
    };
    const timer = setInterval(run, 5000);
    window.addEventListener("online", run);
    run();
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("online", run);
    };
  }, [user]);
  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Действие не выполнено; локальные данные сохранены.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function auth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client) return;
    const values = new FormData(event.currentTarget),
      email = String(values.get("email") ?? ""),
      password = String(values.get("password") ?? "");
    await perform(async () => {
      if (!(await flushEditors()))
        throw new Error("Сначала подтвердите локальное сохранение плана.");
      const result =
        mode === "signup"
          ? await client.auth.signUp({
              email,
              password,
              options: { emailRedirectTo: locationOrigin() },
            })
          : mode === "reset"
            ? await client.auth.resetPasswordForEmail(email, {
                redirectTo: locationOrigin(),
              })
            : mode === "recovery"
              ? await client.auth.updateUser({ password })
              : await client.auth.signInWithPassword({ email, password });
      if (result.error)
        throw new Error(
          "Не удалось выполнить вход или изменить пароль. Проверьте данные, сеть и настройки сервера.",
        );
      if (mode === "signup")
        setMessage(
          "Проверьте почту для подтверждения аккаунта. До подтверждения можно работать локально.",
        );
      if (mode === "reset")
        setMessage(
          "Если адрес зарегистрирован, инструкция восстановления отправлена на почту.",
        );
      if (mode === "recovery") {
        setMode("login");
        setMessage("Пароль обновлён.");
      }
    });
  }
  async function enroll(id: string) {
    await perform(async () => {
      if (!user) return;
      if (!(await flushEditors()))
        throw new Error("Сначала сохраните план локально.");
      await cloud.enroll(id, user.id);
      await worker.current?.run();
    });
  }
  const current = data.states.find((s) => s.projectId === projectId),
    currentProject = data.projects.find((p) => p.id === projectId);
  return (
    <section className="cloud-panel" aria-label="Аккаунт и облако">
      <button onClick={() => setOpen(!open)} aria-expanded={open}>
        {user
          ? `Аккаунт · ${user.email ?? "Выполнен вход"}`
          : "Аккаунт и облако"}
      </button>
      {user && (
        <span className="cloud-status">
          {current?.status === "conflict"
            ? "Конфликт облачных версий"
            : current?.status === "synced"
              ? "Сохранено в облаке"
              : data.outbox.length
                ? "Есть изменения для отправки"
                : "Локальные объекты"}
        </span>
      )}
      {open && (
        <div className="cloud-content">
          <h2>Аккаунт и облако</h2>
          {!client ? (
            <p>
              Облако пока не настроено. Можно продолжать замер и сохранение на
              устройстве. Настройте Supabase по инструкции проекта.
            </p>
          ) : !user || mode === "recovery" ? (
            <>
              <div className="auth-modes">
                <button onClick={() => setMode("login")}>Вход</button>
                <button onClick={() => setMode("signup")}>Регистрация</button>
                <button onClick={() => setMode("reset")}>
                  Восстановить пароль
                </button>
              </div>
              <form onSubmit={auth} aria-label="Форма аккаунта">
                {mode !== "recovery" && (
                  <label>
                    Email
                    <input
                      name="email"
                      type="email"
                      autoComplete="email"
                      required
                    />
                  </label>
                )}
                {mode !== "reset" && (
                  <label>
                    Пароль
                    <input
                      name="password"
                      type="password"
                      minLength={8}
                      autoComplete={
                        mode === "login" ? "current-password" : "new-password"
                      }
                      required
                    />
                  </label>
                )}
                <button className="primary" disabled={busy}>
                  {mode === "login"
                    ? "Войти"
                    : mode === "signup"
                      ? "Зарегистрироваться"
                      : mode === "reset"
                        ? "Отправить инструкцию"
                        : "Сохранить новый пароль"}
                </button>
              </form>
            </>
          ) : (
            <>
              <p>
                {user.email} · локальная копия остаётся на устройстве. Объекты
                этого аккаунта скрываются при выходе.
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    if (!(await flushEditors()))
                      throw new Error("Сначала сохраните изменения локально.");
                    const { error } = await client.auth.signOut({
                      scope: "local",
                    });
                    if (error) throw error;
                  })
                }
              >
                Выйти из аккаунта
              </button>
              <button
                disabled={busy || !root}
                onClick={() =>
                  void perform(async () => {
                    await worker.current?.pull();
                  })
                }
              >
                Загрузить объекты из облака
              </button>
              {!root && (
                <p>
                  Чтобы загрузить облачные версии и разрешить конфликт,
                  вернитесь к списку объектов.
                </p>
              )}
              <button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await repository.db.outbox
                      .where({ ownerId: user.id })
                      .modify({ nextAttemptAt: 0 });
                    await worker.current?.run();
                  })
                }
              >
                Повторить синхронизацию
              </button>
              <button
                onClick={() =>
                  void perform(async () => {
                    const granted = await navigator.storage?.persist?.();
                    setMessage(
                      granted
                        ? "Браузер разрешил постоянное хранение."
                        : "Браузер не разрешил постоянное хранение; сохраняйте облачную копию.",
                    );
                  })
                }
              >
                Защитить локальное хранение
              </button>
              {(root ? data.projects : currentProject ? [currentProject] : [])
                .filter((p) => p.ownerId === null)
                .map((p) => (
                  <div key={p.id}>
                    {p.name}{" "}
                    <button disabled={busy} onClick={() => void enroll(p.id)}>
                      Сохранить объект в облаке
                    </button>
                  </div>
                ))}
              {data.states.map((s) => (
                <p key={s.projectId}>
                  {data.projects.find((p) => p.id === s.projectId)?.name} ·{" "}
                  {s.status === "synced"
                    ? "Облако подтвердило сохранение"
                    : s.status === "conflict"
                      ? "Обе версии сохранены отдельно"
                      : "Ожидает отправки"}
                  {s.lastSyncedAt
                    ? ` · ${new Date(s.lastSyncedAt).toLocaleString("ru-RU")}`
                    : ""}
                </p>
              ))}
              {data.outbox.some((e) => e.error) && (
                <p className="error">
                  Не удалось отправить часть изменений. Локальная очередь
                  сохранена; отправка повторится после восстановления связи.
                </p>
              )}
              {data.conflicts.map((c) => (
                <div
                  className="cloud-conflict"
                  key={c.projectId}
                  data-testid="cloud-conflict"
                >
                  <h3>Другая облачная версия: {c.local.project.name}</h3>
                  <p>
                    Локальная и облачная версии сохранены отдельно. Текущий план
                    не перезаписан.
                  </p>
                  <button
                    disabled={busy || !root}
                    onClick={() =>
                      void perform(async () => {
                        const id = await cloud.resolve(
                          c.projectId,
                          user.id,
                          false,
                        );
                        const floors = await repository.floors(id);
                        navigate(`/projects/${id}/floors/${floors[0].id}`);
                      })
                    }
                  >
                    Открыть отдельную локальную копию
                  </button>
                  <button
                    disabled={busy || !root}
                    onClick={() =>
                      void perform(async () => {
                        await cloud.resolve(c.projectId, user.id, true);
                        setMessage(
                          "Принята облачная версия. Локальная сохранена отдельным объектом.",
                        );
                      })
                    }
                  >
                    Принять облачную, сохранив локальную копию
                  </button>
                </div>
              ))}
            </>
          )}
          {message && (
            <p role="status" className="cloud-message">
              {message}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
const locationOrigin = () => window.location.origin;
