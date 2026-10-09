import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { repository } from "../../infrastructure/database";
import { importProject } from "../../infrastructure/import-repository";
import type { DecodedProject } from "./package";
import { MAX_ARCHIVE } from "./paths";
export function ImportPanel() {
  const [decoded, setDecoded] = useState<DecodedProject>(),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [filename, setFilename] = useState(""),
    navigate = useNavigate(),
    worker = useRef<Worker | null>(null),
    pending = useRef(false),
    active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      worker.current?.terminate();
    };
  }, []);
  async function choose(file: File) {
    if (pending.current) return;
    setDecoded(undefined);
    setError("");
    setBusy(true);
    pending.current = true;
    setFilename(file.name);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!file.size || file.size > MAX_ARCHIVE)
        throw new Error("Выберите ZIP до 256 МБ или project.json до 20 МБ");
      const isJson = file.name.toLowerCase().endsWith(".json");
      if (!isJson && !file.name.toLowerCase().endsWith(".zip"))
        throw new Error("Поддерживаются ZIP и project.json");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!active.current) return;
      const w = new Worker(new URL("./import-worker.ts", import.meta.url), {
        type: "module",
      });
      worker.current = w;
      const data = await new Promise<DecodedProject>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Проверка архива превысила 30 секунд")),
          30000,
        );
        w.onmessage = (
          e: MessageEvent<{ result?: DecodedProject; error?: string }>,
        ) =>
          e.data.result
            ? resolve(e.data.result)
            : reject(new Error(e.data.error));
        w.onerror = () => reject(new Error("Не удалось проверить архив"));
        w.postMessage({ bytes, isJson }, [bytes.buffer]);
      });
      if (active.current) {
        setDecoded(data);
        setName(`${data.manifest.source.project.name.slice(0, 150)} (импорт)`);
      }
    } catch (e) {
      if (active.current)
        setError(e instanceof Error ? e.message : "Некорректный проект");
    } finally {
      if (timer) clearTimeout(timer);
      worker.current?.terminate();
      worker.current = null;
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function restore() {
    if (!decoded || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const copy = await importProject(repository.db, decoded, name);
      navigate(`/projects/${copy.project.id}/floors/${copy.floors[0].id}`);
    } catch (e) {
      if (active.current)
        setError(
          e instanceof Error
            ? e.message
            : "Импорт не сохранён. Проверьте свободное место и повторите.",
        );
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <section
      className="document-panel"
      data-testid="import-panel"
      aria-busy={busy}
    >
      <h2>Восстановить редактируемый проект</h2>
      <p>
        Импорт создаёт отдельный гостевой объект с новыми UUID. Существующие
        объекты и облачные версии не заменяются. Привязки, размеры, статусы,
        фото и состав сметы сохраняются; цены импортируются отдельно для копии.
      </p>
      <label>
        Файл проекта (ZIP или project.json)
        <input
          type="file"
          accept=".zip,.json"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void choose(file);
          }}
        />
      </label>
      {busy && <p role="status">Проверяем или сохраняем проект…</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {decoded && (
        <>
          <p>
            {filename}: этажей {decoded.manifest.source.floors.length}, стен{" "}
            {decoded.manifest.source.walls.length}, помещений{" "}
            {decoded.manifest.source.rooms.length}, фото{" "}
            {decoded.manifest.source.photos.length}, документов{" "}
            {decoded.jsonOnly ? 0 : decoded.manifest.documents.length}
          </p>
          {decoded.jsonOnly && (
            <p className="error">
              Только JSON: геометрия, метаданные фото, цены и состав сметы будут
              восстановлены. Оригиналы и готовые документы не содержатся в JSON;
              для полного восстановления выберите ZIP.
            </p>
          )}
          <label>
            Название импортированного объекта
            <input
              value={name}
              maxLength={160}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button
            className="primary"
            disabled={busy || !name.trim()}
            onClick={() => void restore()}
          >
            Импортировать как новый объект
          </button>
        </>
      )}
    </section>
  );
}
