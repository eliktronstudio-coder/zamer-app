import { useRef, useState } from "react";
import { repository } from "../../infrastructure/database";
import { flushEditors } from "../../editor/flush-editors";
import { exportProject } from "./export-project";
export function ExportPanel({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(""),
    [error, setError] = useState(""),
    [warnings, setWarnings] = useState<string[]>([]),
    pending = useRef(false);
  async function download() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setWarnings([]);
    try {
      if (!(await flushEditors()))
        throw new Error(
          "План не сохранён: разрешите ошибку или конфликт перед экспортом",
        );
      const result = await exportProject(repository.db, projectId, setProgress),
        url = URL.createObjectURL(result.blob),
        a = document.createElement("a");
      a.href = url;
      a.download = result.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setWarnings(result.warnings);
      setProgress("ZIP подготовлен и передан браузеру для скачивания");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось собрать ZIP");
      setProgress("");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      className="document-panel"
      data-testid="export-panel"
      aria-busy={busy}
    >
      <h2>Весь проект одним архивом</h2>
      <p>
        ZIP содержит актуальный отчёт, дефектную ведомость, смету, планы JPEG,
        виды 3D, оригиналы фотографий, историю документов и редактируемые
        данные. Корзина сохраняется в исходных данных. Нужны все оригиналы на
        устройстве.
      </p>
      <p>
        Максимум ZIP — 256 МБ. Цены и состав сметы включаются для этого объекта;
        другие объекты не экспортируются. Дефектная ведомость и смета доступны
        также в XLSX.
      </p>
      <button
        className="primary"
        disabled={busy}
        onClick={() => void download()}
      >
        Скачать весь проект
      </button>
      {progress && <p role="status">{progress}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {warnings.map((w, i) => (
        <p key={i}>{w}</p>
      ))}
    </section>
  );
}
