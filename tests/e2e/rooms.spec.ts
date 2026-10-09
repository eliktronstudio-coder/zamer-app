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
async function rectangle(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "+ Новый объект" }).click();
  await page.getByLabel("Название объекта").fill("Проверка помещений");
  await page.getByRole("button", { name: "Создать и открыть план" }).click();
  await expect(page.getByTestId("plan-canvas")).toBeVisible();
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
  await saved(page);
  await expect(
    page.getByRole("button", { name: /Добавить контур 1 · 12,77/ }),
  ).toBeVisible();
}
async function register(page: Page, name = "Обмер комнаты") {
  await page.getByRole("button", { name: /Добавить контур 1/ }).click();
  await page.getByLabel("Название помещения", { exact: true }).fill(name);
  await page
    .getByRole("button", { name: "Добавить помещение", exact: true })
    .click();
  await saved(page);
}
function q(page: Page, name: string) {
  return page
    .getByTestId("room-properties")
    .locator(`[data-quantity="${name}"]`);
}
test("exact areas, independent completion, project totals and offline reload", async ({
  page,
  context,
}) => {
  await rectangle(page);
  await register(page);
  await expect(q(page, "Площадь пола")).toHaveText("12,77 м²");
  await expect(q(page, "Периметр")).toHaveText("14,51 м");
  await expect(q(page, "Площадь стен")).toHaveText("39,19 м²");
  await expect(q(page, "Объём помещения")).toHaveText("34,48 м³");
  await expect(page.getByTestId("room-status")).toHaveText("В работе");
  await page
    .getByRole("button", { name: "Завершить помещение", exact: true })
    .click();
  await expect(page.getByTestId("room-status")).toHaveText("Завершено");
  await saved(page);
  await page.getByText("Сохранённые итоги объекта", { exact: true }).click();
  await expect(page.locator(".project-quantities")).toContainText("12,77 м²");
  await expect(page.locator(".project-quantities .error")).toHaveCount(0);
  await context.setOffline(true);
  await page.reload();
  await page
    .getByRole("button", {
      name: "Выбрать помещение Обмер комнаты",
      exact: true,
    })
    .click();
  await expect(page.getByTestId("room-status")).toHaveText("Завершено");
  await expect(q(page, "Площадь пола")).toHaveText("12,77 м²");
  await context.setOffline(false);
});
test("unnamed room can finish with notes and later be renamed", async ({
  page,
}) => {
  await rectangle(page);
  await register(page, "");
  await expect(page.getByTestId("room-closure")).toHaveText(
    "Геометрически замкнуто",
  );
  await page
    .getByRole("button", { name: "Завершить помещение", exact: true })
    .click();
  await expect(
    page.getByRole("group", { name: "Проверка завершения" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Исправить сейчас", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Завершить помещение", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Завершить с замечаниями", exact: true })
    .click();
  await expect(page.getByTestId("room-status")).toHaveText(
    "Завершено с замечаниями",
  );
  await page
    .getByLabel("Название помещения", { exact: true })
    .fill("Мой замер");
  await page
    .getByRole("button", { name: "Сохранить помещение", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Завершить помещение", exact: true })
    .click();
  await expect(page.getByTestId("room-status")).toHaveText("Завершено");
  await page
    .getByRole("button", { name: "Удалить помещение", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Добавить контур 1/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await page
    .getByRole("button", { name: "Выбрать помещение Мой замер", exact: true })
    .click();
  await expect(q(page, "Площадь пола")).toHaveText("12,77 м²");
});
test("window subtraction recalculates room and undo restores results", async ({
  page,
}) => {
  await rectangle(page);
  await register(page);
  await page
    .getByRole("button", { name: "Завершить помещение", exact: true })
    .click();
  await page.getByLabel("Строительный инструмент").selectOption("window");
  await page.getByTestId("plan-canvas").click({ position: { x: 180, y: 80 } });
  await saved(page);
  await page
    .getByRole("button", {
      name: "Выбрать помещение Обмер комнаты",
      exact: true,
    })
    .click();
  await expect(q(page, "Площадь окон")).toHaveText("1,68 м²");
  await expect(q(page, "Чистая площадь стен")).toHaveText("37,51 м²");
  await expect(page.getByTestId("room-status")).toHaveText("В работе");
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Выбрать помещение Обмер комнаты",
      exact: true,
    })
    .click();
  await expect(q(page, "Площадь окон")).toHaveText("0,00 м²");
  await expect(page.getByTestId("room-status")).toHaveText("Завершено");
});
test("deleted contour retains room metadata without a false area and undo restores it", async ({
  page,
}) => {
  await rectangle(page);
  await register(page);
  await page.getByText("Поверхности стен (4)", { exact: true }).click();
  await page.getByRole("button", { name: "Стена 1", exact: true }).click();
  await page
    .getByRole("button", { name: "Удалить стену", exact: true })
    .click();
  await saved(page);
  await page
    .getByRole("button", {
      name: "Выбрать помещение Обмер комнаты",
      exact: true,
    })
    .click();
  await expect(page.getByTestId("room-closure")).toHaveText(
    "Контур не замкнут",
  );
  await expect(q(page, "Площадь пола")).toHaveText("Нет достоверного расчёта");
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Выбрать помещение Обмер комнаты",
      exact: true,
    })
    .click();
  await expect(q(page, "Площадь пола")).toHaveText("12,77 м²");
});
