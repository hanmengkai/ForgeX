import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/**/*.test.{ts,tsx}",
      "packages/**/*.test.{ts,tsx}",
      "services/**/*.test.{ts,tsx}",
    ],
    exclude: ["e2e/**", "**/node_modules/**", "**/dist/**"],
  },
});
