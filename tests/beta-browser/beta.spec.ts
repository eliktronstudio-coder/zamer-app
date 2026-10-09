import { test, expect, type Page } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { betaSnapshot } from "../beta/fixture";
import { uuid } from "../geometry/fixtures";
import { createZip, readZip } from "../../src/features/export/zip";
import {
  PROJECT_JSON,
  type PortableProject,
} from "../../src/features/export/package";
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const rows: string[] = [];
  errors.set(page, rows);
  page.on("pageerror", (e) => rows.push(e.message));
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 2,
    ),
  ).toBe(true);
}
async function create(page: Page, name = "Beta замер") {
  await page.goto("/");
  await page.getByRole("button", { name: "+ Новый объект" }).click();
  await page.getByLabel("Название объекта").fill(name);
  await page.getByRole("button", { name: "Создать и открыть план" }).click();
  await page.getByTestId("plan-canvas").waitFor();
}
async function addWall(page: Page) {
  await page.getByRole("button", { name: "Стена", exact: true }).click();
  await page.getByTestId("plan-canvas").click({ position: { x: 80, y: 80 } });
  await page.getByRole("button", { name: "Вправо", exact: true }).click();
  await page.getByLabel("Длина стены, м", { exact: true }).fill("4,257");
  await page.getByLabel("Длина стены, м", { exact: true }).press("Enter");
  await page.getByRole("button", { name: "Завершить цепочку" }).click();
  await expect(page.locator("[data-save-status]")).toHaveAttribute(
    "data-save-status",
    "saved",
  );
}
test("large project culls the canvas, pages all media/issues and remains editable after offline reopen", async ({
  page,
  context,
}, info) => {
  const source = betaSnapshot();
  const png = await readFile(new URL("../fixtures/photo.png", import.meta.url));
  const checksum = createHash("sha256").update(png).digest("hex");
  for (let i = 0; i < 51; i++) {
    const id = uuid(41000 + i);
    source.photos.push({
      id,
      projectId: source.project.id,
      floorId: source.floors[0].id,
      roomId: null,
      elementId: null,
      defectId: null,
      storageKey: `${source.project.id}/${id}/${checksum}`,
      checksum,
      originalName: `Beta_${i}.png`,
      mimeType: "image/png",
      size: png.length,
      caption: `Фото ${i + 1}`,
      createdAt: source.project.createdAt,
      sourceModifiedAt: i,
      deletedAt: null,
    });
  }
  const manifest: PortableProject = {
    format: "zamer-project",
    packageVersion: 1,
    createdAt: source.project.createdAt,
    source,
    prices: [],
    excludedIds: [],
    originals: [
      {
        path: "05_Фотографии/Original.png",
        checksum,
        size: png.length,
        mimeType: "image/png",
      },
    ],
    documents: [],
    artifacts: [],
    warnings: [],
  };
  const zip = createZip(
    new Map([
      [PROJECT_JSON, new TextEncoder().encode(JSON.stringify(manifest))],
      ["05_Фотографии/Original.png", new Uint8Array(png)],
    ]),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Импортировать проект", exact: true })
    .click();
  const start = Date.now();
  await page.getByLabel("Файл проекта (ZIP или project.json)").setInputFiles({
    name: "Beta.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zip),
  });
  await page
    .getByRole("button", { name: "Импортировать как новый объект" })
    .click();
  await expect(page.locator("[data-save-status]")).toContainText("250 стен");
  const importMs = Date.now() - start;
  await expect(
    page.getByText("Проверяем сохранённые этажи…", { exact: true }),
  ).not.toBeVisible({ timeout: 30000 });
  const allFloorIssuesMs = Date.now() - start;
  const canvas = page.getByTestId("plan-canvas");
  const rendered = Number(
    await canvas.getAttribute("data-rendered-wall-count"),
  );
  expect(rendered).toBeGreaterThan(0);
  expect(rendered).toBeLessThan(250);
  await expect(page.getByTestId("photo-card")).toHaveCount(24);
  await expect(page.getByTestId("defect-card")).toHaveCount(24);
  await expect(page.locator("[data-issue-rule]")).toHaveCount(24);
  await page
    .getByRole("button", { name: "Фотографии: следующая страница" })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Фотографии: страницы" }),
  ).toContainText("25–48 из 51");
  await page
    .getByRole("button", { name: "Фотографии: следующая страница" })
    .click();
  await expect(page.getByTestId("photo-card")).toHaveCount(3);
  const original = page.waitForEvent("download");
  await page.getByRole("link", { name: "Скачать оригинал" }).first().click();
  expect(
    Buffer.compare(await readFile((await (await original).path())!), png),
  ).toBe(0);
  await page
    .getByRole("button", { name: "Дефекты: следующая страница" })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Дефекты: страницы" }),
  ).toContainText("25–48 из 50");
  await page
    .getByRole("button", { name: "Дефекты: следующая страница" })
    .click();
  await expect(page.getByTestId("defect-card")).toHaveCount(2);
  await page.getByLabel("Показать нестыковки").selectOption("current");
  await expect(page.locator("[data-issue-rule]")).toHaveCount(24);
  await page
    .getByRole("button", { name: "Нестыковки: следующая страница" })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Нестыковки: страницы" }),
  ).toContainText("25–48");
  await noOverflow(page);
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: `artifacts/${info.project.name}-large.png` });
  await page.getByRole("button", { name: "Рука", exact: true }).click();
  await canvas.scrollIntoViewIfNeeded();
  const panStart = Date.now();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 100, box.y + 200, { steps: 8 });
  await page.mouse.up();
  const metrics = {
    synthetic: true,
    viewport: page.viewportSize(),
    importMs,
    allFloorIssuesMs,
    panGestureMs: Date.now() - panStart,
    renderedWalls: rendered,
    totalFloorWalls: 250,
    heapSampleBytes: await page.evaluate(
      () =>
        (performance as Performance & { memory?: { usedJSHeapSize: number } })
          .memory?.usedJSHeapSize ?? null,
    ),
  };
  await writeFile(
    `artifacts/${info.project.name}-metrics.json`,
    JSON.stringify(metrics, null, 2),
  );
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.evaluate(async () => {
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener(
          "controllerchange",
          () => resolve(),
          { once: true },
        ),
      );
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("[data-save-status]")).toContainText("250 стен");
  await page.getByRole("button", { name: "Стена", exact: true }).click();
  await canvas.click({ position: { x: 80, y: 80 } });
  await page.getByRole("button", { name: "Вправо", exact: true }).click();
  await page.getByLabel("Длина стены, м", { exact: true }).fill("2,123");
  await page.getByLabel("Длина стены, м", { exact: true }).press("Enter");
  await page.getByRole("button", { name: "Завершить цепочку" }).click();
  await expect(page.locator("[data-save-status]")).toHaveAttribute(
    "data-save-status",
    "saved",
  );
  await page.reload();
  await expect(page.locator("[data-save-status]")).toContainText("251 стен");
  await context.setOffline(false);
});
test("literal user text stays inert; keyboard form, PDF and ZIP preserve the measured source", async ({
  page,
}, info) => {
  const name = '<img src=x onerror="window.betaExecuted=1">';
  await create(page, name);
  await addWall(page);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as Window & { betaExecuted?: number }).betaExecuted,
    ),
  ).toBeUndefined();
  await noOverflow(page);
  await page
    .getByRole("button", { name: "Ведомости и документы", exact: true })
    .click();
  await page.getByLabel("Шаблон документа").selectOption("summary");
  await page.getByRole("button", { name: "Создать PDF", exact: true }).click();
  await expect(page.getByTestId("saved-report")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Экспорт всего проекта", exact: true })
    .click();
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Скачать весь проект", exact: true })
    .click();
  const file = await downloaded;
  expect(file.suggestedFilename()).not.toMatch(/[<>:"/\\|?*]/);
  const files = readZip(new Uint8Array(await readFile((await file.path())!)));
  const manifest = JSON.parse(
    new TextDecoder().decode(files.get(PROJECT_JSON)!),
  );
  expect(manifest.source.project.name).toBe(name);
  expect(manifest.source.walls[0].measuredLength).toBe(4.257);
  expect(manifest.documents).toHaveLength(1);
  await page.screenshot({ path: `artifacts/${info.project.name}-export.png` });
});
test("an interrupted canvas gesture never leaves a stuck drag or overwrites saved geometry", async ({
  page,
}) => {
  await create(page);
  await addWall(page);
  const canvas = page.getByTestId("plan-canvas");
  await page.getByRole("button", { name: "Рука", exact: true }).click();
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 150, box.y + 170);
  await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 170);
  await canvas.dispatchEvent("pointercancel", {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  });
  await page.mouse.up();
  await page.getByRole("button", { name: "Выбор", exact: true }).click();
  await canvas.scrollIntoViewIfNeeded();
  await canvas.click({ position: { x: 200, y: 80 } });
  await expect(page.getByLabel("Длина выбранной стены, м")).toHaveValue(
    "4.257",
  );
  await page.reload();
  await expect(page.locator("[data-save-status]")).toContainText("1 стен");
  await expect(canvas).toHaveAttribute("data-rendered-wall-count", "1");
  await noOverflow(page);
});
