import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
const png = readFileSync(new URL("../fixtures/photo.png", import.meta.url));
async function create(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "+ Новый объект" }).click();
  await page.getByLabel("Название объекта").fill("Фото замера");
  await page.getByRole("button", { name: "Создать и открыть план" }).click();
  await expect(page.getByTestId("plan-canvas")).toBeVisible();
}
async function defect(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Дефект", exact: true }).click();
  await page.getByTestId("plan-canvas").click({ position: { x: 120, y: 100 } });
  await page.getByLabel("Описание дефекта").fill("Трещина у окна");
  await page.getByLabel("Длина дефекта, м").fill("2");
  await page.getByLabel("Ширина дефекта, м").fill("0,3");
  await page.getByLabel("Глубина дефекта, м").fill("0,02");
  await page.getByLabel("Рекомендуемый вид работ").fill("Заделка трещины");
  await page
    .getByRole("button", { name: "Сохранить дефект", exact: true })
    .click();
  await expect(page.getByTestId("defect-card")).toContainText("Трещина у окна");
}
test("defect marker, report quantities, attached original and offline reload preserve bytes", async ({
  page,
  context,
}) => {
  await create(page);
  await defect(page);
  await expect(page.locator(".defect-form")).toContainText("0,6 м²");
  await expect
    .poll(() =>
      page.getByTestId("plan-canvas").evaluate((el) => {
        const canvas = Array.from(el.querySelectorAll("canvas")).at(-1)!;
        const pixels = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let red = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (
            pixels[i] > 150 &&
            pixels[i + 1] < 120 &&
            pixels[i + 2] < 120 &&
            pixels[i + 3] > 100
          )
            red++;
        return red;
      }),
    )
    .toBeGreaterThan(50);
  await page.getByLabel("Подпись новых фото").fill("У окна");
  await page.getByLabel("Добавить фото к дефекту").setInputFiles({
    name: "original.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(page.getByTestId("photo-card")).toContainText("original.png");
  await expect(page.getByTestId("photo-card").getByRole("img")).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByTestId("photo-card")
        .getByRole("img")
        .evaluate((el) => (el as HTMLImageElement).naturalWidth),
    )
    .toBe(1280);
  const hash = await page.evaluate(
    async () =>
      new Promise<string>((resolve, reject) => {
        const req = indexedDB.open("zamer-local");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result,
            tx = db.transaction("photoFiles"),
            query = tx.objectStore("photoFiles").getAll();
          query.onsuccess = async () => {
            const buffer = await query.result[0].original.arrayBuffer();
            resolve(
              [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))]
                .map((n) => n.toString(16).padStart(2, "0"))
                .join(""),
            );
            db.close();
          };
        };
      }),
  );
  expect(hash).toBe(createHash("sha256").update(png).digest("hex"));
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId("defect-card")).toContainText("Трещина у окна");
  await expect(page.getByTestId("photo-card").getByRole("img")).toBeVisible();
  await page.getByRole("button", { name: "Показать дефект на плане" }).click();
  await expect(page.getByTestId("plan-canvas")).toBeInViewport();
  await context.setOffline(false);
});
test("photo and defect trash are reversible and project trash keeps attachments", async ({
  page,
}) => {
  await create(page);
  await defect(page);
  await page.getByLabel("Добавить фото к дефекту").setInputFiles({
    name: "original.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(page.getByTestId("photo-card")).toBeVisible();
  await page
    .getByRole("button", { name: "В корзину фото", exact: true })
    .click();
  await expect(page.getByTestId("photo-card")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Корзина дефектов и фото", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Восстановить фото", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Показать активные", exact: true })
    .click();
  await expect(page.getByTestId("photo-card")).toBeVisible();
  await page
    .getByRole("button", { name: "В корзину дефект", exact: true })
    .click();
  await expect(page.getByTestId("defect-card")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Корзина дефектов и фото", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Восстановить дефект", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Показать активные", exact: true })
    .click();
  await expect(page.getByTestId("defect-card")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("photo-card")).toBeVisible();
  await page.getByRole("link", { name: "← Мои объекты", exact: true }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "В корзину", exact: true }).click();
  await page.getByRole("button", { name: /^Корзина/ }).click();
  await page.getByRole("button", { name: "Восстановить", exact: true }).click();
  await page.getByRole("button", { name: /^Активные/ }).click();
  await page
    .getByRole("button", { name: "Открыть план →", exact: true })
    .click();
  await expect(
    page
      .getByTestId("photo-card")
      .getByRole("link", { name: "Скачать оригинал" }),
  ).toBeVisible();
  await expect(page.getByTestId("defect-card")).toContainText("Трещина у окна");
});
test("independent project photos survive reload; unsupported content is rejected", async ({
  page,
}) => {
  await create(page);
  await page.getByLabel("Привязка отдельного фото").selectOption("project");
  await page.getByLabel("Добавить отдельные фото").setInputFiles({
    name: "spoof.png",
    mimeType: "image/png",
    buffer: Buffer.from("bad"),
  });
  await expect(page.getByRole("alert")).toContainText("не соответствует");
  await expect(page.getByTestId("photo-card")).toHaveCount(0);
  await page
    .getByLabel("Добавить отдельные фото")
    .setInputFiles({ name: "first.png", mimeType: "image/png", buffer: png });
  await expect(page.getByTestId("photo-card")).toContainText("first.png");
  await page.reload();
  await expect(page.getByTestId("photo-card")).toContainText("first.png");
});
