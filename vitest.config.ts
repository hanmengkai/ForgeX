import { defineConfig } from "vitest/config";
import { realpath } from "node:fs/promises";

// macOS 默认临时目录含路径别名且过长；测试专用短路径保留业务的严格路径检查。
if (process.platform === "darwin") process.env.TMPDIR = await realpath("/tmp");

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
    coverage: {
      thresholds: {
        statements: 80,
        branches: 69,
        functions: 80,
        lines: 80,
      },
    },
  },
});
