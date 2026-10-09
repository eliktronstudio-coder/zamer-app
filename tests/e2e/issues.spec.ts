import { expect, test, type Page } from "@playwright/test";
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const rows: string[] = [];
  errors.set(page, rows);
  page.on("pageerror", (e) => rows.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("Failed to load resource"))
      rows.push(m.text());
  });
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));
async function saved(page: Page) {
  await expect(page.locator("[data-save-status]")).toHaveAttribute(
    "data-save-status",
    "saved",
  );
}
async function open(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "+ Новый объект" }).click();
  await page.getByLabel("Название объекта").fill("Нестыковки");
  await page.getByRole("button", { name: "Создать и открыть план" }).click();
  await expect(page.getByTestId("plan-canvas")).toBeVisible();
}
async function draw(
  page: Page,
  x: number,
  y: number,
  direction: string,
  length: string,
) {
  await page.getByRole("button", { name: "Стена", exact: true }).click();
  await page.getByTestId("plan-canvas").click({ position: { x, y } });
  await page.getByRole("button", { name: direction, exact: true }).click();
  await page.getByLabel("Длина стены, м", { exact: true }).fill(length);
  await page.getByLabel("Длина стены, м", { exact: true }).press("Enter");
  await page.getByRole("button", { name: "Завершить цепочку" }).click();
  await saved(page);
}
async function gap(page: Page) {
  await open(page);
  await page.getByRole("button", { name: "Привязки", exact: true }).click();
  await draw(page, 80, 80, "Вправо", "2");
  await draw(page, 241.6, 80, "Вниз", "2");
  await expect(page.locator('[data-issue-rule="small-wall-gap"]')).toHaveCount(
    1,
  );
}
async function read(page: Page) {
  return page.evaluate(
    async () =>
      new Promise<{
        walls: {
          id: string;
          start: { x: number; y: number };
          end: { x: number; y: number };
          measuredLength: number;
        }[];
        junctions: unknown[];
      }>((resolve, reject) => {
        const request = indexedDB.open("zamer-local");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction(["walls", "junctions"]),
            walls = tx.objectStore("walls").getAll(),
            junctions = tx.objectStore("junctions").getAll(),
            floorId = location.pathname.split("/").at(-1);
          tx.oncomplete = () => {
            resolve({
              walls: walls.result.filter((w) => w.floorId === floorId),
              junctions: junctions.result.filter((j) => j.floorId === floorId),
            });
            db.close();
          };
        };
      }),
  );
}
test("proposal requires an explicit choice and declining keeps measured geometry", async ({
  page,
  context,
}) => {
  await gap(page);
  const before = await read(page),
    row = page.locator('[data-issue-rule="small-wall-gap"]');
  await row.getByRole("button", { name: "Предложение исправления" }).click();
  await expect(
    row.getByRole("group", { name: "Подтверждение исправления" }),
  ).toBeVisible();
  expect(await read(page)).toEqual(before);
  await row.getByRole("button", { name: "Нет, оставить", exact: true }).click();
  expect(await read(page)).toEqual(before);
  await expect(row.getByRole("group")).toHaveCount(0);
  await expect(
    row.getByRole("button", { name: "Предложение исправления" }),
  ).toHaveCount(0);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('[data-issue-rule="small-wall-gap"]')).toHaveCount(
    1,
  );
  expect(await read(page)).toEqual(before);
  await context.setOffline(false);
});
test("confirmed gap repair saves and undo redo restore both geometry and issues", async ({
  page,
}) => {
  await gap(page);
  const before = await read(page),
    row = page.locator('[data-issue-rule="small-wall-gap"]');
  await row.getByRole("button", { name: "Предложение исправления" }).click();
  await row.getByRole("button", { name: "Да, применить", exact: true }).click();
  await saved(page);
  await expect(page.locator('[data-issue-rule="small-wall-gap"]')).toHaveCount(
    0,
  );
  const after = await read(page);
  expect(
    [after.walls[0].start, after.walls[0].end].some((a) =>
      [after.walls[1].start, after.walls[1].end].some(
        (b) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-9,
      ),
    ),
  ).toBe(true);
  expect(after.walls.map((w) => w.measuredLength)).toEqual([2, 2]);
  expect(after.junctions).toHaveLength(1);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await saved(page);
  expect(await read(page)).toEqual(before);
  await expect(page.locator('[data-issue-rule="small-wall-gap"]')).toHaveCount(
    1,
  );
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await saved(page);
  expect(await read(page)).toEqual(after);
  await page.reload();
  await expect(page.locator('[data-issue-rule="small-wall-gap"]')).toHaveCount(
    0,
  );
});
test("show opens the affected floor, selects the wall and changes viewport without edits", async ({
  page,
}) => {
  await gap(page);
  const originalUrl = page.url(),
    before = await read(page);
  await page
    .getByRole("button", { name: "+ Добавить этаж", exact: true })
    .click();
  await page.getByLabel("Название этажа", { exact: true }).fill("Второй");
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Второй", exact: true }),
  ).toBeVisible();
  const row = page.locator('[data-issue-rule="small-wall-gap"]');
  await expect(row).toContainText("Этаж 1");
  await row.getByRole("link", { name: /Показать:/ }).click();
  await expect(page).toHaveURL(originalUrl);
  await expect(page.getByLabel("Длина выбранной стены, м")).toHaveValue("2");
  expect(await read(page)).toEqual(before);
  await expect(page.getByTestId("plan-canvas")).toBeInViewport();
  await expect
    .poll(() =>
      page
        .getByTestId("plan-canvas")
        .locator("canvas")
        .nth(1)
        .evaluate((canvas) => {
          const c = canvas as HTMLCanvasElement,
            data = c
              .getContext("2d")!
              .getImageData(0, 0, c.width, c.height).data;
          const xs: number[] = [],
            ys: number[] = [];
          for (let i = 0; i < data.length; i += 4)
            if (
              data[i] === 23 &&
              data[i + 1] === 102 &&
              data[i + 2] === 91 &&
              data[i + 3] > 0
            ) {
              const pixel = i / 4;
              xs.push(pixel % c.width);
              ys.push(Math.floor(pixel / c.width));
            }
          return (
            xs.length > 0 &&
            Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - c.width / 2) <
              20 &&
            Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 - c.height / 2) <
              20
          );
        }),
    )
    .toBe(true);

  await page.getByLabel("Показать нестыковки").selectOption("error");
  await expect(page.locator('[data-issue-rule="small-wall-gap"]')).toHaveCount(
    0,
  );
});
test("oversized opening appears in persistent panel and show selects it without blocking repairs", async ({
  page,
}) => {
  await open(page);
  await draw(page, 80, 80, "Вправо", "3");
  await page.getByLabel("Строительный инструмент").selectOption("window");
  await page.getByTestId("plan-canvas").click({ position: { x: 180, y: 80 } });
  await saved(page);
  await page.getByRole("button", { name: "Выбор", exact: true }).click();
  await page.getByTestId("plan-canvas").click({ position: { x: 85, y: 80 } });
  await page.getByLabel("Длина выбранной стены, м").fill("1");
  await page
    .getByRole("button", { name: "Применить параметры", exact: true })
    .click();
  await saved(page);
  const row = page.locator('[data-issue-rule="opening"]');
  await expect(row).toContainText("Проём выходит за длину стены");
  await row.getByRole("button", { name: /Показать:/ }).click();
  await expect(
    page.getByLabel("Ширина проёма, м", { exact: true }),
  ).toHaveValue("1.2");
  await page.getByLabel("Ширина проёма, м", { exact: true }).fill("0.5");
  await page
    .getByLabel("Отступ от начала стены, м", { exact: true })
    .fill("0.2");
  await page
    .getByRole("button", { name: "Применить параметры элемента", exact: true })
    .click();
  await saved(page);
  await expect(page.locator('[data-issue-rule="opening"]')).toHaveCount(0);
});
