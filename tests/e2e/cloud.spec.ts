import { readFileSync } from "node:fs";
import { expect, test, type Page, type BrowserContext } from "@playwright/test";
const base = process.env.CLOUD_TEST_BASE_URL;
test.skip(
  !base,
  "Configured cloud build is tested separately with mocked Supabase endpoints.",
);
const a = "00000000-0000-4000-8000-000000000900",
  b = "00000000-0000-4000-8000-000000000901";
type Snapshot = {
  project: { id: string; ownerId: string; name: string };
  floors: { id: string }[];
};
function session(id: string, email: string) {
  const user = {
    id,
    aud: "authenticated",
    role: "authenticated",
    email,
    email_confirmed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
  };
  const token = [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(
      JSON.stringify({
        sub: id,
        role: "authenticated",
        aud: "authenticated",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url"),
    "test-signature",
  ].join(".");
  return {
    access_token: token,
    refresh_token: `test-${id}`,
    expires_in: 3600,
    token_type: "bearer",
    user,
  };
}
async function mock(context: BrowserContext) {
  const projects = new Map<string, { revision: number; snapshot: Snapshot }>(),
    commands = new Map<string, unknown>();
  const files = new Map<string, Buffer>();
  let storageFail = false;
  let fail = false,
    pushes = 0;
  await context.route(
    "https://zamer-sync-test.supabase.co/**",
    async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.pathname.includes("/auth/v1/token")) {
        const body = request.postDataJSON(),
          id = body.email?.startsWith("b@") ? b : a;
        await route.fulfill({
          json: session(id, body.email ?? "a@example.test"),
        });
        return;
      }
      if (url.pathname.includes("/auth/v1/logout")) {
        await route.fulfill({ status: 204 });
        return;
      }
      if (url.pathname.includes("/auth/v1/signup")) {
        await route.fulfill({
          json: { user: session(a, "a@example.test").user },
        });
        return;
      }
      if (url.pathname.includes("/auth/v1/recover")) {
        await route.fulfill({ json: {} });
        return;
      }
      if (url.pathname.includes("/auth/v1/user")) {
        const jwt = request.headers().authorization?.split(" ")[1],
          id = jwt
            ? JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString())
                .sub
            : a;
        await route.fulfill({ json: session(id, "a@example.test").user });
        return;
      }
      if (url.pathname.includes("/storage/v1/object/")) {
        const key = decodeURIComponent(
            url.pathname.split("zamer-originals/")[1] ?? "",
          ),
          projectId = key.split("/")[0];
        const jwt = request.headers().authorization?.split(" ")[1],
          uid = jwt
            ? JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString())
                .sub
            : null;
        if (projects.get(projectId)?.snapshot.project.ownerId !== uid) {
          await route.fulfill({ status: 403, json: { message: "Forbidden" } });
          return;
        }
        if (storageFail) {
          await route.abort("failed");
          return;
        }
        if (request.method() === "POST") {
          const body = request.postDataBuffer()!,
            ct = request.headers()["content-type"];
          let bytes = body;
          if (ct?.includes("boundary=")) {
            const boundary = ct.split("boundary=")[1],
              marker = body.indexOf('filename="'),
              start = body.indexOf("\r\n\r\n", marker) + 4,
              end = body.indexOf(`\r\n--${boundary}`, start);
            bytes = body.subarray(start, end);
          }
          if (files.has(key)) {
            await route.fulfill({
              status: 409,
              json: { statusCode: "409", message: "Exists" },
            });
            return;
          }
          files.set(key, bytes);
          await route.fulfill({ json: { Key: `zamer-originals/${key}` } });
          return;
        }
        const bytes = files.get(key);
        await route.fulfill(
          bytes
            ? { contentType: "image/png", body: bytes }
            : { status: 404, json: { message: "Missing" } },
        );
        return;
      }
      if (url.pathname.endsWith("/zamer_push")) {
        pushes++;
        if (fail) {
          await route.abort("failed");
          return;
        }
        const body = request.postDataJSON(),
          old = projects.get(body.project_id);
        let result = commands.get(body.command_id);
        if (!result) {
          if (old && old.revision !== body.base_revision)
            result = { type: "conflict", ...old };
          else {
            const revision = (old?.revision ?? 0) + 1;
            projects.set(body.project_id, {
              revision,
              snapshot: body.snapshot,
            });
            result = { type: "ack", revision };
          }
          commands.set(body.command_id, result);
        }
        await route.fulfill({ json: result });
        return;
      }
      if (url.pathname.endsWith("/zamer_list")) {
        const jwt = request.headers().authorization?.split(" ")[1],
          id = jwt
            ? JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString())
                .sub
            : a;
        await route.fulfill({
          json: [...projects.values()].filter(
            (p) => p.snapshot.project.ownerId === id,
          ),
        });
        return;
      }
      await route.fulfill({ status: 404, json: { message: "unhandled" } });
    },
  );
  return {
    projects,
    files,
    setStorageFail: (v: boolean) => {
      storageFail = v;
    },
    setFail: (v: boolean) => {
      fail = v;
    },
    pushes: () => pushes,
  };
}
async function login(page: Page, email = "a@example.test") {
  const toggle = page.getByRole("button", {
    name: "Аккаунт и облако",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill("example-password");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: new RegExp(`Аккаунт · ${email.replace(".", "\\.")}`),
    }),
  ).toBeVisible();
}
async function create(page: Page) {
  await page.getByRole("button", { name: "+ Новый объект" }).click();
  await page.getByLabel("Название объекта").fill("Облачный замер");
  await page.getByRole("button", { name: "Создать и открыть план" }).click();
  await expect(page.getByTestId("plan-canvas")).toBeVisible();
}
async function readQueue(page: Page) {
  return page.evaluate(
    async () =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open("zamer-local");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result,
            tx = db.transaction("outbox"),
            count = tx.objectStore("outbox").count();
          tx.oncomplete = () => {
            resolve(count.result);
            db.close();
          };
        };
      }),
  );
}
test("guest can enroll a project, cloud ACK preserves local copy, logout hides it", async ({
  page,
  context,
}) => {
  const backend = await mock(context);
  await page.goto(base!);
  await login(page);
  await create(page);
  await page
    .getByRole("button", { name: "Сохранить объект в облаке", exact: true })
    .click();
  await expect(page.locator(".cloud-content")).toContainText(
    "Облако подтвердило сохранение",
  );
  expect(backend.projects.size).toBe(1);
  expect(await readQueue(page)).toBe(0);
  await page.getByRole("link", { name: "← Мои объекты", exact: true }).click();
  await page
    .getByRole("button", { name: "Выйти из аккаунта", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Аккаунт и облако", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Облачный замер", { exact: true })).toHaveCount(
    0,
  );
  await login(page, "b@example.test");
  await expect(page.getByText("Облачный замер", { exact: true })).toHaveCount(
    0,
  );
});
test("failed upload survives reload and retries without deleting the local project", async ({
  page,
  context,
}) => {
  const backend = await mock(context);
  backend.setFail(true);
  await page.goto(base!);
  await login(page);
  await create(page);
  await page
    .getByRole("button", { name: "Сохранить объект в облаке", exact: true })
    .click();
  await expect(page.locator(".cloud-content")).toContainText(
    "Локальная очередь сохранена",
  );
  expect(await readQueue(page)).toBe(1);
  await page.reload();
  await expect(page.getByTestId("plan-canvas")).toBeVisible();
  await page.getByRole("button", { name: /Аккаунт ·/ }).click();
  backend.setFail(false);
  await page
    .getByRole("button", { name: "Повторить синхронизацию", exact: true })
    .click();
  await expect(page.locator(".cloud-content")).toContainText(
    "Облако подтвердило сохранение",
  );
  expect(await readQueue(page)).toBe(0);
  expect(backend.projects.size).toBe(1);
});
test("remote changes keep both versions and explicit acceptance makes a local backup", async ({
  page,
  context,
}) => {
  const backend = await mock(context);
  await page.goto(base!);
  await login(page);
  await create(page);
  await page
    .getByRole("button", { name: "Сохранить объект в облаке", exact: true })
    .click();
  await expect(page.locator(".cloud-content")).toContainText(
    "Облако подтвердило сохранение",
  );
  const [id, stored] = [...backend.projects][0];
  backend.projects.set(id, {
    revision: 2,
    snapshot: {
      ...stored.snapshot,
      project: { ...stored.snapshot.project, name: "Другой компьютер" },
    },
  });
  await page.getByRole("link", { name: "← Мои объекты", exact: true }).click();
  await page
    .getByRole("button", { name: "Загрузить объекты из облака", exact: true })
    .click();
  await expect(page.getByTestId("cloud-conflict")).toContainText(
    "не перезаписан",
  );
  await expect(
    page.getByText("Облачный замер", { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Принять облачную, сохранив локальную копию",
      exact: true,
    })
    .click();
  await expect(page.getByTestId("cloud-conflict")).toHaveCount(0);
  await expect(
    page.getByText("Облачный замер (локальная копия)", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Другой компьютер", { exact: true }).first(),
  ).toBeVisible();
});
test("new browser downloads an owned object and opens its local plan", async ({
  page,
  context,
  browser,
}) => {
  const backend = await mock(context);
  await page.goto(base!);
  await login(page);
  await create(page);
  await page
    .getByRole("button", { name: "Сохранить объект в облаке", exact: true })
    .click();
  await expect(page.locator(".cloud-content")).toContainText(
    "Облако подтвердило сохранение",
  );
  const second = await browser.newContext(),
    secondBackend = await mock(second);
  for (const [id, value] of backend.projects)
    secondBackend.projects.set(id, value);
  const other = await second.newPage();
  await other.goto(base!);
  await login(other);
  await other
    .getByRole("button", { name: "Загрузить объекты из облака", exact: true })
    .click();
  await expect(
    other.getByRole("heading", { name: "Облачный замер", exact: true }),
  ).toBeVisible();
  await other
    .getByRole("button", { name: "Открыть план →", exact: true })
    .click();
  await expect(other.getByTestId("plan-canvas")).toBeVisible();
  await second.close();
});
test("signup and password recovery remain optional and never block guest creation", async ({
  page,
  context,
}) => {
  await mock(context);
  await page.goto(base!);
  await page
    .getByRole("button", { name: "Аккаунт и облако", exact: true })
    .click();
  await page.getByRole("button", { name: "Регистрация", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill("a@example.test");
  await page.getByLabel("Пароль", { exact: true }).fill("example-password");
  await page
    .getByRole("button", { name: "Зарегистрироваться", exact: true })
    .click();
  await expect(page.locator(".cloud-content")).toContainText("Проверьте почту");
  await page
    .getByRole("button", { name: "Восстановить пароль", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Отправить инструкцию", exact: true })
    .click();
  await expect(page.locator(".cloud-content")).toContainText(
    "Если адрес зарегистрирован",
  );
  await create(page);
  await expect(page.getByTestId("plan-canvas")).toBeVisible();
});

test("cloud ACK waits for verified originals; lost storage response retries and another device downloads bytes", async ({
  page,
  context,
  browser,
}) => {
  const backend = await mock(context);
  backend.setStorageFail(true);
  const png = readFileSync(new URL("../fixtures/photo.png", import.meta.url));
  await page.goto(base!);
  await login(page);
  await create(page);
  await page.getByLabel("Добавить отдельные фото").setInputFiles({
    name: "original.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(page.getByTestId("photo-card")).toBeVisible();
  await page
    .getByRole("button", { name: "Сохранить объект в облаке", exact: true })
    .click();
  await expect(page.locator(".cloud-content")).toContainText(
    "Локальная очередь сохранена",
  );
  expect(await readQueue(page)).toBe(1);
  expect(backend.projects.size).toBe(1);
  backend.setStorageFail(false);
  await page
    .getByRole("button", { name: "Повторить синхронизацию", exact: true })
    .click();
  await expect(page.locator(".cloud-content")).toContainText(
    "Облако подтвердило сохранение",
  );
  expect(await readQueue(page)).toBe(0);
  expect([...backend.projects.values()][0].revision).toBe(1);
  expect([...backend.files.values()][0]).toEqual(png);
  const second = await browser.newContext(),
    remote = await mock(second);
  for (const [id, p] of backend.projects) remote.projects.set(id, p);
  for (const [key, value] of backend.files) remote.files.set(key, value);
  const other = await second.newPage();
  await other.goto(base!);
  await login(other);
  await other
    .getByRole("button", { name: "Загрузить объекты из облака", exact: true })
    .click();
  await other
    .getByRole("button", { name: "Открыть план →", exact: true })
    .click();
  await expect(other.getByTestId("photo-card")).toContainText("не загружен");
  await other
    .getByRole("button", { name: "Загрузить оригинал", exact: true })
    .click();
  await expect(other.getByTestId("photo-card").getByRole("img")).toBeVisible();
  await expect(
    other
      .getByTestId("photo-card")
      .getByRole("link", { name: "Скачать оригинал" }),
  ).toBeVisible();
  await second.close();
});
