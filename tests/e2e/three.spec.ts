import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
test.use({
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  },
});
async function create(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "+ Новый объект" }).click();
  await page.getByLabel("Название объекта").fill("3D замер");
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
}
async function three(page: Page) {
  await page.getByRole("button", { name: "3D вид", exact: true }).click();
  await expect(page.getByTestId("three-canvas").locator("canvas")).toHaveCount(
    1,
  );
  await expect(
    page.getByRole("button", { name: "Скачать снимок 3D" }),
  ).toBeEnabled();
}
async function identities(page: Page) {
  return page.evaluate(
    async () =>
      new Promise<unknown>((resolve, reject) => {
        const r = indexedDB.open("zamer-local");
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result,
            tx = db.transaction(["walls", "projects"]),
            walls = tx.objectStore("walls").getAll(),
            projects = tx.objectStore("projects").getAll();
          tx.oncomplete = () => {
            resolve({ walls: walls.result, projects: projects.result });
            db.close();
          };
        };
      }),
  );
}
test("3D renders the shared walls, camera navigation and source selection return to 2D without changing data", async ({
  page,
  isMobile,
}) => {
  await create(page);
  await expect(page.locator("[data-save-status]")).toHaveAttribute(
    "data-save-status",
    "saved",
  );
  const before = await identities(page);
  await three(page);
  await expect(page.getByTestId("three-canvas")).toHaveAttribute(
    "data-meshes",
    "4",
  );
  const camera = await page
    .getByTestId("three-canvas")
    .getAttribute("data-camera");
  await page.getByRole("button", { name: "Вид сверху", exact: true }).click();
  await expect(page.getByTestId("three-canvas")).not.toHaveAttribute(
    "data-camera",
    camera!,
  );
  await page.getByRole("button", { name: "Показать всю 3D модель" }).click();
  if (!isMobile) {
    await page.getByTestId("three-canvas").scrollIntoViewIfNeeded();
    const r = (await page.getByTestId("three-canvas").boundingBox())!;
    const previous = await page
      .getByTestId("three-canvas")
      .getAttribute("data-camera");
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width / 2 + 50, r.y + r.height / 2 + 20, {
      steps: 5,
    });
    await page.mouse.up();
    await expect(page.getByTestId("three-canvas")).not.toHaveAttribute(
      "data-camera",
      previous!,
    );
  }
  if (isMobile) {
    await page.getByTestId("three-canvas").scrollIntoViewIfNeeded();
    const r = (await page.getByTestId("three-canvas").boundingBox())!,
      cdp = await page.context().newCDPSession(page),
      previous = await page
        .getByTestId("three-canvas")
        .getAttribute("data-camera"),
      x = r.x + r.width / 2,
      y = r.y + r.height / 2;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: x - 20, y, id: 1 },
        { x: x + 20, y, id: 2 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: x - 55, y, id: 1 },
        { x: x + 55, y, id: 2 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(page.getByTestId("three-canvas")).not.toHaveAttribute(
      "data-camera",
      previous!,
    );
    await cdp.detach();
  }
  await page
    .getByText("Элементы модели и переход в 2D", { exact: true })
    .click();
  await page
    .getByRole("button", { name: "Стена №1 → 2D", exact: true })
    .click();
  await expect(page.getByTestId("plan-canvas")).toBeVisible();
  await expect(
    page.getByLabel("Длина выбранной стены, м", { exact: true }),
  ).toHaveValue("4.257");
  expect(await identities(page)).toEqual(before);
});
test("PNG screenshot and 3D remain available after offline reload", async ({
  page,
  context,
}) => {
  await create(page);
  await three(page);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Скачать снимок 3D", exact: true })
    .click();
  const file = await download,
    bytes = await readFile((await file.path())!);
  expect(bytes.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  expect(bytes.readUInt32BE(16)).toBeGreaterThan(100);
  expect(bytes.readUInt32BE(20)).toBeGreaterThan(100);
  expect(bytes.length).toBeGreaterThan(2000);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await three(page);
  await expect(page.getByTestId("three-canvas")).toHaveAttribute(
    "data-meshes",
    "4",
  );
  await context.setOffline(false);
});
test("unavailable WebGL shows a recoverable message and 2D still works", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      ...args: Parameters<typeof original>
    ) {
      if (String(args[0]).startsWith("webgl")) return null;
      return Reflect.apply(original, this, args);
    } as typeof original;
  });
  await create(page);
  await page.getByRole("button", { name: "3D вид", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("3D недоступен");
  await expect(
    page.getByRole("button", { name: "Скачать снимок 3D" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "2D план", exact: true }).click();
  await expect(page.getByTestId("plan-canvas")).toBeVisible();
});

test("repeated view switches keep one renderer and ray selection resolves a source element", async ({
  page,
}) => {
  await create(page);
  for (let n = 0; n < 4; n++) {
    await three(page);
    await page.getByRole("button", { name: "2D план", exact: true }).click();
    await expect(page.getByTestId("three-canvas")).toHaveCount(0);
    await expect(page.getByTestId("plan-canvas").locator("canvas")).toHaveCount(
      6,
    );
  }
  await three(page);
  const canvas = page.getByTestId("three-canvas").locator("canvas"),
    r = (await canvas.boundingBox())!;
  const selection = page.getByRole("button", {
    name: "Открыть выбранный элемент в 2D",
    exact: true,
  });
  for (const x of [0.4, 0.5, 0.6]) {
    for (const y of [0.4, 0.5, 0.6, 0.7]) {
      await canvas.click({ position: { x: r.width * x, y: r.height * y } });
      if (await selection.count()) break;
    }
    if (await selection.count()) break;
  }
  await expect(selection).toBeVisible();
  await selection.click();
  await expect(page.getByTestId("plan-canvas")).toBeVisible();
});
