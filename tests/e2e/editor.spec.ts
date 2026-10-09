import { test, expect, type Page } from "@playwright/test";
import type { Wall, Dimension, Junction } from "../../src/domain/model";
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().includes("Failed to load resource")
    )
      errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  test.info().annotations.push({
    type: "runtime-check",
    description: "Canvas errors must fail the scenario",
  });
  runtimeErrors.set(page, errors);
});
const runtimeErrors = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page)).toEqual([]);
});
async function expectRenderedWall(page: Page) {
  await expect(page.getByTestId("plan-canvas").locator("canvas")).toHaveCount(
    6,
  );
  await expect
    .poll(() =>
      page
        .getByTestId("plan-canvas")
        .locator("canvas")
        .nth(1)
        .evaluate((canvas) => {
          const c = canvas as HTMLCanvasElement;
          const data = c
            .getContext("2d")!
            .getImageData(0, 0, c.width, c.height).data;
          return data.some((value, index) => index % 4 === 3 && value > 0);
        }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page
        .getByTestId("plan-canvas")
        .locator("canvas")
        .nth(3)
        .evaluate((canvas) => {
          const c = canvas as HTMLCanvasElement;
          const data = c
            .getContext("2d")!
            .getImageData(0, 0, c.width, c.height).data;
          return data.some((value, index) => index % 4 === 3 && value > 0);
        }),
    )
    .toBe(true);
}
async function openEditor(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "+ Новый объект" }).click();
  await page.getByLabel("Название объекта").fill("Замер редактора");
  await page.getByRole("button", { name: "Создать и открыть план" }).click();
  await expect(page.getByTestId("plan-canvas")).toBeVisible();
}
async function saved(page: Page) {
  await expect(page.locator("[data-save-status]")).toHaveAttribute(
    "data-save-status",
    "saved",
  );
}
async function readScene(page: Page) {
  return page.evaluate(async () => {
    const floorId = location.pathname.split("/").at(-1)!;
    return new Promise<{
      walls: Wall[];
      dimensions: Dimension[];
      junctions: Junction[];
    }>((resolve, reject) => {
      const request = indexedDB.open("zamer-local");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction(["walls", "dimensions", "junctions"]);
        const walls = tx.objectStore("walls").getAll(),
          dimensions = tx.objectStore("dimensions").getAll(),
          junctions = tx.objectStore("junctions").getAll();
        tx.oncomplete = () => {
          db.close();
          resolve({
            walls: (walls.result as Wall[]).filter(
              (w) => w.floorId === floorId,
            ),
            dimensions: (dimensions.result as Dimension[]).filter(
              (d) => d.floorId === floorId,
            ),
            junctions: (junctions.result as Junction[]).filter(
              (j) => j.floorId === floorId,
            ),
          });
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
}
async function firstPoint(page: Page) {
  await page.getByRole("button", { name: "Стена", exact: true }).click();
  await page.getByTestId("plan-canvas").click({ position: { x: 80, y: 80 } });
}
async function measured(page: Page, direction: string, length: string) {
  await page.getByRole("button", { name: direction, exact: true }).click();
  await page.getByLabel("Длина стены, м", { exact: true }).fill(length);
  await page.getByLabel("Длина стены, м", { exact: true }).press("Enter");
}
test("precise rectangle, linked dimensions, undo/redo and offline reload", async ({
  page,
  context,
}) => {
  await openEditor(page);
  await firstPoint(page);
  await measured(page, "Вправо", "4,257");
  await measured(page, "Вниз", "3");
  await measured(page, "Влево", "4,257");
  await measured(page, "Вверх", "3");
  await page.getByRole("button", { name: "Завершить цепочку" }).click();
  await expect(page.locator("[data-save-status]")).toContainText("4 стен");
  await saved(page);
  await expectRenderedWall(page);
  const original = await readScene(page);
  expect(original.walls).toHaveLength(4);
  expect(original.dimensions).toHaveLength(4);
  expect(original.junctions).toHaveLength(4);
  expect(original.walls.filter((w) => w.measuredLength === 4.257)).toHaveLength(
    2,
  );
  await page.getByRole("button", { name: "Выбор", exact: true }).click();
  await page.getByTestId("plan-canvas").click({ position: { x: 108, y: 200 } });
  await expect(
    page.getByRole("heading", { name: "Управляющий размер", exact: true }),
  ).toBeVisible();
  await page.getByTestId("plan-canvas").focus();
  await page.keyboard.press("Control+z");
  await expect(page.locator("[data-save-status]")).toContainText("3 стен");
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(page.locator("[data-save-status]")).toContainText("4 стен");
  await saved(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.getByTestId("plan-canvas")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null),
    )
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("[data-save-status]")).toContainText("4 стен");
  expect(await readScene(page)).toEqual(original);
  await context.setOffline(false);
});
test("selected wall moves with its dimension, ignores micro-movement, resizes and deletes with undo", async ({
  page,
}) => {
  await openEditor(page);
  await firstPoint(page);
  await measured(page, "Вправо", "2");
  await page.getByRole("button", { name: "Завершить цепочку" }).click();
  await page.getByRole("button", { name: "Выбор", exact: true }).click();
  await saved(page);
  await expectRenderedWall(page);
  const original = await readScene(page);
  await page.getByTestId("plan-canvas").click({ position: { x: 160, y: 80 } });
  const box = await page.getByTestId("plan-canvas").boundingBox();
  if (!box) throw new Error("missing canvas");
  const point = { x: box.x + 160, y: box.y + 80 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 2, point.y + 1);
  await page.mouse.up();
  await saved(page);
  expect((await readScene(page)).walls[0].start).toEqual(
    original.walls[0].start,
  );
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 40, point.y + 40, { steps: 8 });
  await page.mouse.up();
  await saved(page);
  const moved = await readScene(page);
  expect(moved.walls[0].start.x).toBeCloseTo(
    original.walls[0].start.x + 0.5,
    10,
  );
  expect(moved.walls[0].start.y).toBeCloseTo(
    original.walls[0].start.y + 0.5,
    10,
  );
  expect(moved.dimensions[0].from.elementId).toBe(moved.walls[0].id);
  await page.getByLabel("Длина выбранной стены, м").fill("2,257");
  await page.getByRole("button", { name: "Применить параметры" }).click();
  await saved(page);
  expect((await readScene(page)).walls[0].measuredLength).toBe(2.257);
  await page.getByRole("button", { name: "Удалить стену" }).click();
  await expect(page.locator("[data-save-status]")).toContainText("0 стен");
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect(page.locator("[data-save-status]")).toContainText("1 стен");
  await saved(page);
  expect((await readScene(page)).dimensions).toHaveLength(1);
});
test("viewport controls, reference dimension and floor switching flush pending edits", async ({
  page,
}) => {
  await openEditor(page);
  await page.getByRole("button", { name: "+ Добавить этаж" }).click();
  await page.getByLabel("Название этажа").fill("Второй");
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Второй" })).toBeVisible();
  await page.getByRole("link", { name: "▧ Этаж 1", exact: true }).click();
  await firstPoint(page);
  await measured(page, "Вправо", "2");
  await page.getByRole("button", { name: "Завершить цепочку" }).click();
  await page.getByRole("button", { name: "Размер", exact: true }).click();
  await page.getByTestId("plan-canvas").click({ position: { x: 160, y: 80 } });
  await expect(
    page.getByRole("heading", { name: "Справочный размер" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Увеличить масштаб" }).click();
  await expect(page.getByLabel("Масштаб", { exact: true })).toHaveText("125%");
  await page.getByRole("button", { name: "Уменьшить масштаб" }).click();
  await expect(page.getByLabel("Масштаб", { exact: true })).toHaveText("100%");
  await page.getByRole("link", { name: "▧ Второй", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Второй" })).toBeVisible();
  await expect(page.getByLabel("Пустой план")).toBeVisible();
  await page.getByRole("link", { name: "▧ Этаж 1", exact: true }).click();
  await expect(page.locator("[data-save-status]")).toContainText("1 стен");
  expect((await readScene(page)).dimensions).toHaveLength(2);
  await page.getByRole("button", { name: "Ортогонально", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Ортогонально", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("touch pan and pinch change the viewport without creating geometry", async ({
  page,
  context,
}) => {
  await openEditor(page);
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 2,
  });
  await page.getByTestId("plan-canvas").scrollIntoViewIfNeeded();
  const bounds = await page.getByTestId("plan-canvas").boundingBox();
  if (!bounds) throw new Error("missing canvas");
  const x = bounds.x + 120,
    y = bounds.y + 180;
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ id: 1, x, y }],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ id: 1, x: x + 30, y: y + 30 }],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { id: 1, x: x - 30, y },
      { id: 2, x: x + 30, y },
    ],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { id: 1, x: x - 60, y },
      { id: 2, x: x + 60, y },
    ],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(page.getByLabel("Масштаб", { exact: true })).toHaveText("200%");
  await expect(page.getByLabel("Пустой план")).toBeVisible();
  expect((await readScene(page)).walls).toEqual([]);
  await session.detach();
});

test("two tabs preserve both conflicting plans and recover a copy on a new floor", async ({
  page,
  context,
}) => {
  await openEditor(page);
  await firstPoint(page);
  await measured(page, "Вправо", "2");
  await page.getByRole("button", { name: "Завершить цепочку" }).click();
  await page.getByRole("button", { name: "Выбор", exact: true }).click();
  await saved(page);
  const sourceUrl = page.url();
  const other = await context.newPage();
  await other.goto(sourceUrl);
  await expect(other.getByTestId("plan-canvas")).toBeVisible();
  await other.getByTestId("plan-canvas").click({ position: { x: 160, y: 80 } });
  await page.getByLabel("Длина выбранной стены, м").fill("2,257");
  await page.getByRole("button", { name: "Применить параметры" }).click();
  await saved(page);
  await other.getByLabel("Длина выбранной стены, м").fill("3,257");
  await other.getByRole("button", { name: "Применить параметры" }).click();
  await expect(other.locator("[data-save-status]")).toHaveAttribute(
    "data-save-status",
    "conflict",
  );
  await expect(
    other.getByText("Ваша версия сохранена отдельной локальной копией.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    other.locator('[data-issue-rule="version-conflict"]'),
  ).toContainText("Конфликт версий");
  expect((await readScene(page)).walls[0].measuredLength).toBe(2.257);
  await other
    .getByRole("button", { name: "Восстановить копию на новом этаже" })
    .click();
  await expect(
    other.getByRole("heading", { name: "Этаж 1 (восстановлено)", exact: true }),
  ).toBeVisible();
  await saved(other);
  const copy = await readScene(other);
  expect(copy.walls[0].measuredLength).toBe(3.257);
  expect(copy.dimensions[0].from.elementId).toBe(copy.walls[0].id);
  expect(copy.walls[0].id).not.toBe((await readScene(page)).walls[0].id);
  await other.reload();
  expect((await readScene(other)).walls[0].measuredLength).toBe(3.257);
  await other.goto(sourceUrl);
  await expect(other.locator("[data-save-status]")).toHaveAttribute(
    "data-save-status",
    "saved",
  );
  expect((await readScene(other)).walls[0].measuredLength).toBe(2.257);
  await expect(
    other.getByRole("button", { name: "Восстановить копию на новом этаже" }),
  ).toHaveCount(0);
  await other.close();
});

test("editing a wall offline survives reload with its associated dimension", async ({
  page,
  context,
}) => {
  await openEditor(page);
  await firstPoint(page);
  await measured(page, "Вправо", "2");
  await page.getByRole("button", { name: "Завершить цепочку" }).click();
  await page.getByRole("button", { name: "Выбор", exact: true }).click();
  await saved(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.getByTestId("plan-canvas")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null),
    )
    .toBe(true);
  await context.setOffline(true);
  await page.getByTestId("plan-canvas").click({ position: { x: 160, y: 80 } });
  await page.getByLabel("Длина выбранной стены, м").fill("4,257");
  await page.getByRole("button", { name: "Применить параметры" }).click();
  await saved(page);
  const offline = await readScene(page);
  expect(offline.walls[0].measuredLength).toBe(4.257);
  expect(offline.dimensions[0].inputValue).toBe(4.257);
  await page.reload();
  await expect(page.getByTestId("plan-canvas")).toBeVisible();
  expect(await readScene(page)).toEqual(offline);
  await context.setOffline(false);
});
