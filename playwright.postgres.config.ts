import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "production-workflow.spec.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "postgres-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "node e2e/support/postgres-control-plane.mjs",
      url: "http://127.0.0.1:3000/health/ready",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        "npm run preview --workspace @forgex/web-console -- --host 127.0.0.1 --port 4174",
      url: "http://127.0.0.1:4174",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
