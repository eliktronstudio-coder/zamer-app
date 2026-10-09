import { test, expect } from "@playwright/test";
test("guest creates an empty project, adds a floor and reloads offline", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "+ Новый объект" }).click();
  await page.getByLabel("Название объекта").fill("Тестовый объект");
  await page.getByLabel("Первый этаж").fill("Первый этаж");
  await page.getByRole("button", { name: "Создать и открыть план" }).click();
  await expect(
    page.getByRole("heading", { name: "Первый этаж" }),
  ).toBeVisible();
  await expect(page.getByLabel("Пустой план")).toBeVisible();
  await page.getByRole("button", { name: "+ Добавить этаж" }).click();
  await page.getByLabel("Название этажа").fill("Второй этаж");
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Второй этаж" }),
  ).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Второй этаж" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null),
    )
    .toBe(true);
  await context.setOffline(true);
  await expect(page.getByText("Офлайн · на устройстве")).toBeVisible();
  await page.getByRole("button", { name: "+ Добавить этаж" }).click();
  await page.getByLabel("Название этажа").fill("Офлайн этаж");
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Офлайн этаж" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Офлайн этаж" }),
  ).toBeVisible();
  // Chromium network emulation can reset navigator.onLine after a SW navigation.
  // Verify actual network failure, not the emulated flag, after offline reload.
  await expect(
    page.evaluate(async () => {
      try {
        await fetch("/offline-probe?nonce=" + crypto.randomUUID(), {
          cache: "no-store",
        });
        return false;
      } catch {
        return true;
      }
    }),
  ).resolves.toBe(true);
  await context.setOffline(false);
  await page.getByRole("link", { name: "← Мои объекты" }).click();
  await page.getByRole("button", { name: "В архив", exact: true }).click();
  await page.getByRole("button", { name: /^Архив/ }).click();
  await expect(
    page.getByRole("heading", { name: "Тестовый объект" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Восстановить" }).click();
  await page.getByRole("button", { name: /^Активные/ }).click();
  await expect(
    page.getByRole("heading", { name: "Тестовый объект" }),
  ).toBeVisible();
});

test("rename, search, trash confirmation and restore preserve the project", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "+ Новый объект" }).click();
  await page.getByLabel("Название объекта").fill("Старое название");
  await page.getByRole("button", { name: "Создать и открыть план" }).click();
  await page.getByRole("link", { name: "← Мои объекты" }).click();
  await page.getByRole("button", { name: "Переименовать" }).click();
  await page.getByLabel("Новое название").fill("Новое название");
  await page.getByRole("button", { name: "Применить" }).click();
  await expect(
    page.getByRole("heading", { name: "Новое название" }),
  ).toBeVisible();
  await page.getByLabel("Поиск по названию").fill("Несуществующий");
  await expect(
    page.getByRole("heading", { name: "Объекты не найдены" }),
  ).toBeVisible();
  await page.getByLabel("Поиск по названию").fill("новое");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "В корзину" }).click();
  await expect(
    page.getByRole("heading", { name: "Новое название" }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "В корзину" }).click();
  await page.getByRole("button", { name: /^Корзина/ }).click();
  await expect(
    page.getByRole("heading", { name: "Новое название" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Восстановить" }).click();
  await page.getByRole("button", { name: /^Активные/ }).click();
  await page.getByRole("button", { name: "Открыть план →" }).click();
  await expect(page.getByRole("heading", { name: "Этаж 1" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
