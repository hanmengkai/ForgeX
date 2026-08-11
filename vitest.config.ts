import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
    maxWorkers: 4,
    include: [
      "apps/**/*.test.{ts,tsx}",
      "packages/**/*.test.{ts,tsx}",
      "services/**/*.test.{ts,tsx}",
    ],
    exclude: ["e2e/**", "**/node_modules/**", "**/dist/**"],
  },
});
