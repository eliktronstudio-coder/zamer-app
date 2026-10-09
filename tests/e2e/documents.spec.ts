import { test, expect, type Page } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { unzipSync, strFromU8 } from "fflate";
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
  await page.getByLabel("Название объекта").fill("Документы — кириллица");
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
  await page.getByLabel("Название помещения", { exact: true }).fill("Кухня");
  await page
    .getByRole("button", { name: "Добавить помещение", exact: true })
    .click();
  await expect(page.locator("[data-save-status]")).toHaveAttribute(
    "data-save-status",
    "saved",
  );
}
async function open(page: Page) {
  await page
    .getByRole("button", { name: "Ведомости и документы", exact: true })
    .click();
  await expect(page.getByTestId("work-row")).toHaveCount(4);
}
async function price(page: Page) {
  await page.getByText("Справочник цен", { exact: true }).click();
  await page.getByLabel("Цена: Отделка пола, м²").fill("123,45");
  await page
    .getByRole("button", { name: "Сохранить цену: Отделка пола, м²" })
    .click();
  await expect(page.getByTestId("estimate-total")).toContainText("1 576,58 ₽");
}
test("model quantities and reusable prices survive reload; unknown prices keep the estimate partial", async ({
  page,
}) => {
  await create(page);
  await open(page);
  await expect(
    page.getByTestId("work-row").filter({ hasText: "Отделка пола" }),
  ).toContainText("12,771 м²");
  await price(page);
  await expect(page.getByTestId("estimate-total")).toContainText(
    "смета неполная",
  );
  await expect(page.getByTestId("estimate-total")).toContainText(
    "строк без суммы: 3",
  );
  await page.reload();
  await open(page);
  await expect(page.getByTestId("estimate-total")).toContainText("1 576,58 ₽");
  const row = page
    .getByTestId("work-row")
    .filter({ hasText: "Штукатурка стен" });
  await row.getByText("Происхождение расчёта", { exact: true }).click();
  await expect(row).toContainText("Площадь стен");
  await expect(row).toContainText("− окна");
  await page.getByText("Справочник цен", { exact: true }).click();
  await page.getByLabel("Цена: Отделка пола, м²").fill("-5");
  await page
    .getByRole("button", { name: "Сохранить цену: Отделка пола, м²" })
    .click();
  await expect(page.getByRole("alert")).toContainText("неотрицательную цену");
  await expect(page.getByTestId("estimate-total")).toContainText("1 576,58 ₽");
  for (const name of [
    "Отделка потолка",
    "Штукатурка стен",
    "Отделка откосов",
  ]) {
    await page
      .getByTestId("work-row")
      .filter({ hasText: name })
      .getByRole("checkbox")
      .uncheck();
    await expect(page.getByTestId("document-panel")).toHaveAttribute(
      "aria-busy",
      "false",
    );
  }
  await expect(page.getByTestId("estimate-total")).toContainText(
    "строк без суммы: 0",
  );
  await expect(page.getByTestId("estimate-total")).not.toContainText(
    "смета неполная",
  );
  await page.reload();
  await open(page);
  await expect(
    page
      .getByTestId("work-row")
      .filter({ hasText: "Штукатурка стен" })
      .getByRole("checkbox"),
  ).not.toBeChecked();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 2,
      ),
    )
    .toBe(true);
  await page
    .getByTestId("document-panel")
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.screenshot({
    path: `/tmp/zamer-phase10/${test.info().project.name}-documents.png`,
  });
});
test("PDF includes Cyrillic, photos, plans and 3D; history detects changed prices and original bytes survive", async ({
  page,
}, testInfo) => {
  await create(page);
  const png = await readFile(new URL("../fixtures/photo.png", import.meta.url));
  await page.getByLabel("Привязка отдельного фото").selectOption("project");
  await page.getByLabel("Добавить отдельные фото").setInputFiles({
    name: "Оригинал.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(page.getByTestId("photo-card")).toBeVisible();
  await open(page);
  await page.getByLabel("Виды 3D", { exact: true }).check();
  await page.getByRole("button", { name: "Создать PDF", exact: true }).click();
  const history = page.getByTestId("saved-report");
  await expect(history).toHaveCount(1, { timeout: 20000 });
  await expect(history).toContainText("Соответствует прочитанным данным");
  const downloaded = page.waitForEvent("download");
  await history.getByRole("button", { name: /^Скачать .*\.pdf$/ }).click();
  const download = await downloaded,
    bytes = await readFile((await download.path())!);
  const pdf = await PDFDocument.load(bytes);
  expect(pdf.getPageCount()).toBeGreaterThanOrEqual(3);
  expect(pdf.getTitle()).toContain("Документы — кириллица");
  expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-");
  await mkdir("/tmp/zamer-phase10", { recursive: true });
  await download.saveAs(
    `/tmp/zamer-phase10/${testInfo.project.name}-report.pdf`,
  );
  const original = page.waitForEvent("download");
  await page
    .getByTestId("photo-card")
    .getByRole("link", { name: "Скачать оригинал" })
    .click();
  expect(await readFile((await (await original).path())!)).toEqual(png);
  await price(page);
  await expect(history).toContainText("Снимок прежних данных или цен");
  await page.reload();
  await open(page);
  await expect(page.getByTestId("saved-report")).toHaveCount(1);
});
test("first document use after offline reload exports scoped multi-page JPEG with cached Cyrillic font", async ({
  page,
  context,
}) => {
  await create(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await context.setOffline(true);
  await page.reload();
  await open(page);
  const option = await page
    .getByLabel("Область документа")
    .locator("option")
    .filter({ hasText: "/ Кухня" })
    .getAttribute("value");
  await page.getByLabel("Область документа").selectOption(option!);
  await page.getByLabel("Шаблон документа").selectOption("quantities");
  await page.getByLabel("Планы 2D", { exact: true }).check();
  await page.getByLabel("Смета", { exact: true }).check();
  await page.getByLabel("Помещения", { exact: true }).check();
  await page.getByRole("button", { name: "Создать JPEG", exact: true }).click();
  const history = page.getByTestId("saved-report");
  await expect(history).toHaveCount(1, { timeout: 20000 });
  await expect(history).toContainText("Кухня");
  const buttons = history.getByRole("button", { name: /^Скачать .*\.jpg$/ });
  expect(await buttons.count()).toBeGreaterThan(1);
  const downloadPromise = page.waitForEvent("download");
  await buttons.first().click();
  const download = await downloadPromise,
    bytes = await readFile((await download.path())!);
  expect([...bytes.subarray(0, 3)]).toEqual([255, 216, 255]);
  const size = await page.evaluate(async (base64) => {
    const blob = await (await fetch(`data:image/jpeg;base64,${base64}`)).blob(),
      bitmap = await createImageBitmap(blob);
    const size = [bitmap.width, bitmap.height];
    bitmap.close();
    return size;
  }, bytes.toString("base64"));
  expect(size).toEqual([1191, 1684]);
  await context.setOffline(false);
});
test("document storage failure leaves plan intact and can be retried without partial history", async ({
  page,
}) => {
  await create(page);
  await open(page);
  await page.getByLabel("Шаблон документа").selectOption("summary");
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === "documents")
        throw new DOMException(
          "Не хватает места для документа",
          "QuotaExceededError",
        );
      return key === undefined
        ? original.call(this, value)
        : original.call(this, value, key);
    };
  });
  await page.getByRole("button", { name: "Создать PDF", exact: true }).click();
  await expect(
    page.getByTestId("document-panel").getByRole("alert"),
  ).toContainText("Не хватает места");
  await expect(page.getByTestId("saved-report")).toHaveCount(0);
  await page.reload();
  await open(page);
  await expect(
    page.getByTestId("work-row").filter({ hasText: "Отделка пола" }),
  ).toContainText("12,771 м²");
  await page.getByLabel("Шаблон документа").selectOption("summary");
  await page.getByRole("button", { name: "Создать PDF", exact: true }).click();
  await expect(page.getByTestId("saved-report")).toHaveCount(1, {
    timeout: 20000,
  });
});

test("XLSX preserves numeric estimates and saved history after offline reload", async ({
  page,
  context,
}, testInfo) => {
  await create(page);
  await open(page);
  await price(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await context.setOffline(true);
  await page.reload();
  await open(page);
  await page.getByLabel("Смета", { exact: true }).check();
  await page.getByRole("button", { name: "Создать XLSX", exact: true }).click();
  const history = page.getByTestId("saved-report");
  await expect(history).toHaveCount(1);
  await expect(history).toContainText("XLSX");
  const pending = page.waitForEvent("download");
  await history.getByRole("button", { name: /^Скачать .*\.xlsx$/ }).click();
  const download = await pending;
  const bytes = await readFile((await download.path())!);
  const files = unzipSync(bytes);
  const sheets = Object.entries(files).filter(([name]) =>
    /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
  );
  const estimate = sheets
    .map(([, value]) => strFromU8(value))
    .find((value) => value.includes("точные копейки"))!;
  expect(estimate).toContain("<v>123.45</v>");
  expect(estimate).toContain("<v>1576.58</v>");
  expect(estimate).toContain("157658");
  expect(estimate).toContain("Цена не задана");
  expect(estimate).not.toMatch(/<f[ >]/);
  await mkdir("artifacts", { recursive: true });
  await download.saveAs(`artifacts/${testInfo.project.name}-report.xlsx`);
  await page.reload();
  await open(page);
  await expect(page.getByTestId("saved-report")).toHaveCount(1);
  const again = page.waitForEvent("download");
  await page
    .getByTestId("saved-report")
    .getByRole("button", { name: /^Скачать .*\.xlsx$/ })
    .click();
  expect(await readFile((await (await again).path())!)).toEqual(bytes);
});
