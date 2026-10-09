import { defineConfig } from "@playwright/test";
const chromium = {
  browserName: "chromium" as const,
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  },
};
export default defineConfig({
  testDir: "tests/beta-browser",
  outputDir: "test-results/beta-browser",
  timeout: 90000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4190", trace: "retain-on-failure" },
  webServer: {
    command: "npm run preview -- --port 4190",
    url: "http://127.0.0.1:4190",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: "beta-laptop",
      use: { ...chromium, viewport: { width: 1366, height: 768 } },
    },
    {
      name: "beta-tablet",
      use: {
        ...chromium,
        viewport: { width: 1024, height: 768 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "beta-phone",
      use: {
        ...chromium,
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    ...(process.env.BETA_ALL_ENGINES === "1"
      ? [
          {
            name: "beta-firefox",
            use: {
              browserName: "firefox" as const,
              viewport: { width: 1366, height: 768 },
            },
          },
          {
            name: "beta-webkit",
            use: {
              browserName: "webkit" as const,
              viewport: { width: 390, height: 844 },
              isMobile: true,
              hasTouch: true,
            },
          },
        ]
      : []),
  ],
});
