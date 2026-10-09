import { test, expect, type Page } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { readZip, createZip } from "../../src/features/export/zip";
import { PROJECT_JSON } from "../../src/features/export/package";
test.use({
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  },
});
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const rows: string[] = [];
  errors.set(page, rows);
  page.on("pageerror", (e) => rows.push(e.message));
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));
async function create(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "+ Новый объект" }).click();
  await page.getByLabel("Название объекта").fill("Дом: / 1");
  await page.getByRole("button", { name: "Создать и открыть план" }).click();
  await page.getByTestId("plan-canvas").waitFor();
  await page.getByRole("button", { name: "Стена", exact: true }).click();
  await page.getByTestId("plan-canvas").click({ position: { x: 80, y: 80 } });
  for (const [direction, length] of [
    ["Вправо", "4,257"],
    ["Вниз", "3"],
    ["Влево", "4,257"],
    ["Вверх", "3"],
  ]) {
    await page.getByRole("button", { name: direction, exact: true }).click();
    await page.getByLabel("Длина стены, м", { exact: true }).fill(length);
    await page.getByLabel("Длина стены, м", { exact: true }).press("Enter");
  }
  await page.getByRole("button", { name: "Завершить цепочку" }).click();
  await page.getByRole("button", { name: /Добавить контур 1/ }).click();
  await page
    .getByLabel("Название помещения", { exact: true })
    .fill("Кухня/../1");
  await page
    .getByRole("button", { name: "Добавить помещение", exact: true })
    .click();
  await expect(page.locator("[data-save-status]")).toHaveAttribute(
    "data-save-status",
    "saved",
  );
}
async function downloadZip(page: Page) {
  await page
    .getByRole("button", { name: "Экспорт всего проекта", exact: true })
    .click();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Скачать весь проект", exact: true })
    .click();
  const download = await downloading;
  return {
    download,
    bytes: new Uint8Array(await readFile((await download.path())!)),
  };
}
async function importFile(page: Page, bytes: Uint8Array, name = "Проект.zip") {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Импортировать проект", exact: true })
    .click();
  await page.getByLabel("Файл проекта (ZIP или project.json)").setInputFiles({
    name,
    mimeType: name.endsWith(".json") ? "application/json" : "application/zip",
    buffer: Buffer.from(bytes),
  });
}
test("full ZIP has safe folders, editable data, originals and reports; import preserves rates and history without replacing source", async ({
  page,
}, info) => {
  await create(page);
  const png = await readFile(new URL("../fixtures/photo.png", import.meta.url));
  const option = await page
    .getByLabel("Привязка отдельного фото")
    .locator("option")
    .filter({ hasText: "Кухня/../1" })
    .getAttribute("value");
  await page.getByLabel("Привязка отдельного фото").selectOption(option!);
  await page.getByLabel("Добавить отдельные фото").setInputFiles({
    name: "Оригинал.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(page.getByTestId("photo-card")).toBeVisible();
  await page
    .getByRole("button", { name: "Ведомости и документы", exact: true })
    .click();
  await page.getByText("Справочник цен", { exact: true }).click();
  await page.getByLabel("Цена: Отделка пола, м²").fill("123,45");
  await page
    .getByRole("button", { name: "Сохранить цену: Отделка пола, м²" })
    .click();
  await expect(page.getByTestId("estimate-total")).toContainText("1 576,58 ₽");
  await page.getByLabel("Шаблон документа").selectOption("summary");
  await page.getByRole("button", { name: "Создать PDF", exact: true }).click();
  await expect(page.getByTestId("saved-report")).toHaveCount(1);
  const { download, bytes } = await downloadZip(page),
    files = readZip(bytes),
    manifest = JSON.parse(new TextDecoder().decode(files.get(PROJECT_JSON)!));
  for (const folder of [
    "00_Общий_отчет",
    "01_Планы",
    "02_3D",
    "03_Дефектная_ведомость",
    "04_Смета",
    "05_Фотографии",
    "06_Исходные_данные",
  ])
    expect([...files.keys()].some((p) => p.startsWith(folder + "/"))).toBe(
      true,
    );
  expect(
    manifest.source.walls
      .map((wall: { measuredLength: number }) => wall.measuredLength)
      .sort((a: number, b: number) => a - b),
  ).toEqual([3, 3, 4.257, 4.257]);
  expect(manifest.documents).toHaveLength(1);
  expect(manifest.packageVersion).toBe(2);
  for (const path of [
    "03_Дефектная_ведомость/defects.xlsx",
    "04_Смета/estimate.xlsx",
  ]) {
    const workbook = readZip(files.get(path)!);
    expect(workbook.has("xl/workbook.xml")).toBe(true);
    const sheets = [...workbook.entries()].filter(([name]) =>
      name.startsWith("xl/worksheets/"),
    );
    expect(sheets.length).toBeGreaterThanOrEqual(2);
    if (path.includes("estimate"))
      expect(
        sheets.map(([, bytes]) => new TextDecoder().decode(bytes)).join("\n"),
      ).toContain("<v>1576.58</v>");
  }
  expect(manifest.prices[0].kopecks).toBe(12345);
  expect(Buffer.from(files.get(manifest.originals[0].path)!)).toEqual(png);
  expect([...files.keys()].every((p) => !p.split("/").includes(".."))).toBe(
    true,
  );
  await mkdir("/tmp/zamer-phase11", { recursive: true });
  await download.saveAs(`/tmp/zamer-phase11/${info.project.name}-Project.zip`);
  await writeFile(
    `/tmp/zamer-phase11/${info.project.name}-estimate.pdf`,
    files.get("04_Смета/estimate.pdf")!,
  );
  await importFile(page, bytes);
  await expect(
    page.getByRole("button", {
      name: "Импортировать как новый объект",
      exact: true,
    }),
  ).toBeEnabled({ timeout: 15000 });
  await page
    .getByLabel("Название импортированного объекта")
    .fill("Восстановленный дом");
  await page
    .getByRole("button", {
      name: "Импортировать как новый объект",
      exact: true,
    })
    .click();
  await page.getByTestId("plan-canvas").waitFor();
  await page
    .getByRole("button", { name: "Ведомости и документы", exact: true })
    .click();
  await expect(page.getByTestId("estimate-total")).toContainText("1 576,58 ₽");
  await expect(page.getByTestId("saved-report")).toHaveCount(1);
  const original = page.waitForEvent("download");
  await page
    .getByTestId("photo-card")
    .getByRole("link", { name: "Скачать оригинал" })
    .click();
  expect(await readFile((await (await original).path())!)).toEqual(png);
  await page.getByRole("link", { name: "← Мои объекты", exact: true }).click();
  await expect(page.locator(".project-card")).toHaveCount(2);
});
test("first ZIP import after offline reload restores a new editable copy and JSON-only warning is explicit", async ({
  page,
  context,
}) => {
  await create(page);
  const { bytes } = await downloadZip(page),
    files = readZip(bytes);
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await context.setOffline(true);
  await page.reload();
  await page
    .getByRole("button", { name: "Импортировать проект", exact: true })
    .click();
  await page.getByLabel("Файл проекта (ZIP или project.json)").setInputFiles({
    name: "project.json",
    mimeType: "application/json",
    buffer: Buffer.from(files.get(PROJECT_JSON)!),
  });
  await expect(page.getByTestId("import-panel")).toContainText("Только JSON");
  await page.getByLabel("Файл проекта (ZIP или project.json)").setInputFiles({
    name: "backup.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(bytes),
  });
  await expect(
    page.getByRole("button", {
      name: "Импортировать как новый объект",
      exact: true,
    }),
  ).toBeEnabled({ timeout: 15000 });
  await page
    .getByRole("button", {
      name: "Импортировать как новый объект",
      exact: true,
    })
    .click();
  await page.getByTestId("plan-canvas").waitFor();
  await page.getByRole("button", { name: "Стена", exact: true }).click();
  await page.getByTestId("plan-canvas").click({ position: { x: 200, y: 150 } });
  await page.getByRole("button", { name: "Вправо", exact: true }).click();
  await page.getByLabel("Длина стены, м", { exact: true }).fill("2,123");
  await page.getByLabel("Длина стены, м", { exact: true }).press("Enter");
  await page.getByRole("button", { name: "Завершить цепочку" }).click();
  await expect(page.locator("[data-save-status]")).toHaveAttribute(
    "data-save-status",
    "saved",
  );
  await page.reload();
  await expect(page.locator("[data-save-status]")).toContainText("5 стен");
  await context.setOffline(false);
});
test("bad archive is rejected before import; missing originals prevent a falsely complete export", async ({
  page,
}) => {
  await create(page);
  const png = await readFile(new URL("../fixtures/photo.png", import.meta.url));
  await page
    .getByLabel("Добавить отдельные фото")
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: png });
  await expect(page.getByTestId("photo-card")).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const r = indexedDB.open("zamer-local");
        r.onsuccess = () => {
          const db = r.result,
            tx = db.transaction("photoFiles", "readwrite");
          tx.objectStore("photoFiles").clear();
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await page
    .getByRole("button", { name: "Экспорт всего проекта", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Скачать весь проект", exact: true })
    .click();
  await expect(
    page.getByTestId("export-panel").getByRole("alert"),
  ).toContainText("не загружен");
  await importFile(page, createZip(new Map([["x", new Uint8Array([1])]])));
  await expect(
    page.getByTestId("import-panel").getByRole("alert"),
  ).toContainText("project.json");
  await expect(
    page.getByRole("button", {
      name: "Импортировать как новый объект",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page.locator(".project-card")).toHaveCount(1);
});
