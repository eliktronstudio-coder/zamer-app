import { expect, test, type Page } from "@playwright/test";
import type { ConstructionElement, Wall } from "../../src/domain/model";
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
test.afterEach(({ page }) => {
  expect(errors.get(page)).toEqual([]);
});
async function open(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "+ Новый объект" }).click();
  await page.getByLabel("Название объекта").fill("Конструкции");
  await page.getByRole("button", { name: "Создать и открыть план" }).click();
  await expect(page.getByTestId("plan-canvas")).toBeVisible();
}
async function saved(page: Page) {
  await expect(page.locator("[data-save-status]")).toHaveAttribute(
    "data-save-status",
    "saved",
  );
}
async function tool(page: Page, value: string) {
  await page.getByLabel("Строительный инструмент").selectOption(value);
}
async function point(page: Page, x: number, y: number) {
  await page.getByTestId("plan-canvas").click({ position: { x, y } });
}
async function read(page: Page) {
  return page.evaluate(async () => {
    const floorId = location.pathname.split("/").at(-1);
    return new Promise<{ elements: ConstructionElement[]; walls: Wall[] }>(
      (resolve, reject) => {
        const request = indexedDB.open("zamer-local");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction(["elements", "walls"]),
            elements = tx.objectStore("elements").getAll(),
            walls = tx.objectStore("walls").getAll();
          tx.oncomplete = () => {
            db.close();
            resolve({
              elements: (elements.result as ConstructionElement[]).filter(
                (e) => e.floorId === floorId,
              ),
              walls: (walls.result as Wall[]).filter(
                (w) => w.floorId === floorId,
              ),
            });
          };
        };
      },
    );
  });
}
async function wall(page: Page, length = "3") {
  await page.getByRole("button", { name: "Стена", exact: true }).click();
  await point(page, 80, 80);
  await page.getByRole("button", { name: "Вправо", exact: true }).click();
  await page.getByLabel("Длина стены, м", { exact: true }).fill(length);
  await page.getByLabel("Длина стены, м", { exact: true }).press("Enter");
  await page.getByRole("button", { name: "Завершить цепочку" }).click();
  await saved(page);
}
async function pixels(page: Page) {
  await expect
    .poll(() =>
      page
        .getByTestId("plan-canvas")
        .locator("canvas")
        .nth(2)
        .evaluate((canvas) => {
          const c = canvas as HTMLCanvasElement;
          return c
            .getContext("2d")!
            .getImageData(0, 0, c.width, c.height)
            .data.some((value, i) => i % 4 === 3 && value > 0);
        }),
    )
    .toBe(true);
}

test("all column sections validate, render, save and survive undo and reload", async ({
  page,
}) => {
  await open(page);
  const shapes = [
    "circle",
    "ellipse",
    "square",
    "rectangle",
    "L",
    "T",
    "cross",
    "H",
    "U",
    "box",
    "polygon",
    "custom",
    "composite",
  ];
  for (const shape of shapes) {
    await tool(page, "column");
    await page
      .getByRole("combobox", { name: "Форма сечения", exact: true })
      .first()
      .selectOption(shape);
    if (shape === "circle")
      await page.getByLabel("Диаметр, м", { exact: true }).fill("0,457");
    if (shape === "composite") {
      await page
        .getByRole("group", { name: "Часть 2", exact: true })
        .getByLabel("Диаметр, м", { exact: true })
        .fill("0,657");
      await page
        .getByRole("button", { name: "Добавить часть", exact: true })
        .click();
      await page
        .getByRole("group", { name: "Часть 1", exact: true })
        .getByRole("button", { name: "Удалить часть", exact: true })
        .click();
      await expect(
        page
          .getByRole("group", { name: "Часть 1", exact: true })
          .getByLabel("Диаметр, м", { exact: true }),
      ).toHaveValue("0.657");
    }
    await page
      .getByRole("button", { name: "Использовать параметры", exact: true })
      .click();
    await point(page, 100, 180);
    await saved(page);
    await pixels(page);
  }
  const original = await read(page);
  expect(original.elements).toHaveLength(13);
  expect(
    original.elements.some(
      (e) =>
        e.kind === "column" &&
        e.section.kind === "circle" &&
        e.section.diameter === 0.457,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await saved(page);
  expect((await read(page)).elements).toHaveLength(12);
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await saved(page);
  expect((await read(page)).elements).toHaveLength(13);
  await page.reload();
  await expect(page.getByTestId("plan-canvas")).toBeVisible();
  expect(await read(page)).toEqual(original);
  await pixels(page);
});

test("all construction types persist offline, edit selected properties and delete with undo", async ({
  page,
  context,
}) => {
  await open(page);
  await wall(page);
  for (const [type, x] of [
    ["window", 128],
    ["door", 200],
    ["void", 272],
  ] as const) {
    await tool(page, type);
    await page.getByLabel("Ширина проёма, м").fill("0,6");
    await page
      .getByRole("button", { name: "Использовать параметры", exact: true })
      .click();
    await point(page, x, 80);
    await saved(page);
  }
  for (const [type, x, y] of [
    ["column", 100, 180],
    ["stair", 210, 200],
    ["ramp", 210, 330],
  ] as const) {
    await tool(page, type);
    await point(page, x, y);
    await saved(page);
  }
  await tool(page, "beam");
  await point(page, 80, 260);
  await point(page, 200, 260);
  await saved(page);
  await tool(page, "levelChange");
  await point(page, 80, 350);
  await point(page, 160, 350);
  await page
    .getByRole("button", { name: "Завершить границу (2)", exact: true })
    .click();
  await saved(page);
  const scene = await read(page);
  expect(scene.elements).toHaveLength(8);
  expect(new Set(scene.elements.map((e) => e.kind)).size).toBe(6);
  await pixels(page);
  await page.getByRole("button", { name: "Выбор", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Свойства: Перепад уровня",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("Конечная отметка, м").fill("-0,257");
  await page
    .getByRole("button", { name: "Применить параметры элемента", exact: true })
    .click();
  await saved(page);
  expect(
    (await read(page)).elements.some(
      (e) => e.kind === "levelChange" && e.toElevation === -0.257,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Удалить элемент", exact: true })
    .click();
  await saved(page);
  expect((await read(page)).elements).toHaveLength(7);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await saved(page);
  const original = await read(page);
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
  await expect(page.getByTestId("plan-canvas")).toBeVisible();
  expect(await read(page)).toEqual(original);
  await pixels(page);
  await context.setOffline(false);
});

test("opening follows its wall, retains impossible measurements and can be repaired", async ({
  page,
}) => {
  await open(page);
  await wall(page, "2");
  await tool(page, "window");
  await point(page, 160, 80);
  await saved(page);
  const original = await read(page);
  const opening = original.elements[0];
  expect(opening.kind).toBe("opening");
  await page.getByRole("button", { name: "Выбор", exact: true }).click();
  await point(page, 85, 80);
  await expect(
    page.getByRole("heading", { name: "Свойства стены", exact: true }),
  ).toBeVisible();
  const box = await page.getByTestId("plan-canvas").boundingBox();
  if (!box) throw new Error();
  await page.mouse.move(box.x + 85, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + 85, box.y + 120, { steps: 8 });
  await page.mouse.up();
  await saved(page);
  const moved = await read(page);
  expect(moved.walls[0].start.y).toBeCloseTo(
    original.walls[0].start.y + 0.5,
    12,
  );
  expect(moved.elements[0]).toEqual(opening);
  await page.getByLabel("Длина выбранной стены, м").fill("1");
  await page
    .getByRole("button", { name: "Применить параметры", exact: true })
    .click();
  await saved(page);
  await expect(page.getByRole("alert")).toContainText(
    "Проём выходит за длину стены",
  );
  expect((await read(page)).elements[0]).toEqual(opening);
  await point(page, 140, 120);
  await expect(
    page.getByRole("heading", { name: "Свойства: Окно", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Ширина проёма, м").fill("0,5");
  await page
    .getByRole("button", { name: "Применить параметры элемента", exact: true })
    .click();
  await saved(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await point(page, 85, 120);
  await page
    .getByRole("button", { name: "Удалить стену", exact: true })
    .click();
  await saved(page);
  expect((await read(page)).elements).toHaveLength(0);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await saved(page);
  expect((await read(page)).elements).toHaveLength(1);
});

test("invalid section parameters and unfinished level boundaries never modify the saved scene", async ({
  page,
}) => {
  await open(page);
  await tool(page, "column");
  await page
    .getByRole("combobox", { name: "Форма сечения", exact: true })
    .selectOption("H");
  await page.getByLabel("Толщина полки, м").fill("1");
  await page
    .getByRole("button", { name: "Использовать параметры", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Толщины профиля");
  expect((await read(page)).elements).toHaveLength(0);
  await point(page, 100, 180);
  await expect(page.getByRole("alert")).toContainText("Примените параметры");
  expect((await read(page)).elements).toHaveLength(0);
  await tool(page, "levelChange");
  await point(page, 100, 180);
  await page.getByTestId("plan-canvas").press("Escape");
  await saved(page);
  expect((await read(page)).elements).toHaveLength(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
