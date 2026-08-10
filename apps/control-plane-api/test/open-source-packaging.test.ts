import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFile(join(root, path), "utf8");

describe("开源交付包装", () => {
  it("提供许可证、社区治理与安全披露入口", async () => {
    const [license, contributing, security, conduct] = await Promise.all([
      read("LICENSE"),
      read("CONTRIBUTING.md"),
      read("SECURITY.md"),
      read("CODE_OF_CONDUCT.md"),
    ]);

    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0");
    expect(contributing).toContain("npm test");
    expect(security).toContain("请勿公开披露");
    expect(conduct).toContain("尊重");
  });

  it("提供可复现的 Compose 部署与不会携带明文凭据的配置模板", async () => {
    const [
      compose,
      dockerfile,
      webDockerfile,
      dockerignore,
      nginx,
      runtimeConfig,
      readme,
    ] = await Promise.all([
      read("deploy/compose.yaml"),
      read("Dockerfile"),
      read("apps/web-console/Dockerfile"),
      read(".dockerignore"),
      read("deploy/nginx.conf"),
      read("deploy/config/control-plane.example.json"),
      read("README.md"),
    ]);

    for (const service of ["postgres:", "migrate:", "control-plane:", "web:"]) {
      expect(compose).toContain(service);
    }
    expect(compose).toContain("healthcheck:");
    expect(compose).toContain("FORGEX_CONTROL_PLANE_CONFIG_SHA256");
    expect(compose).toContain("FORGEX_DATABASE_URL:");
    expect(compose).not.toContain("postgresql://${FORGEX_POSTGRES_USER");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).not.toContain("COPY services ./services");
    expect(dockerfile).not.toContain("/app /app");
    expect(webDockerfile).toContain("nginx-unprivileged");
    expect(dockerignore).toContain("**/*.config.json");
    expect(dockerignore).toContain("test-results");
    expect(nginx.slice(0, nginx.indexOf("location /api/"))).not.toContain(
      "Content-Security-Policy",
    );
    expect(nginx.slice(nginx.indexOf("location /api/"))).toContain(
      "Content-Security-Policy",
    );
    expect(runtimeConfig).toContain("tokenSha256");
    expect(runtimeConfig).not.toMatch(/"(?:token|password|sessionKey)"\s*:/u);
    expect(readme).toContain("docker compose");
    expect(readme).toContain("npm run db:migrate");
    expect(readme).toContain("0014_browser_sessions.sql");
    expect(readme).toContain("0015_worker_enrollments.sql");
  });

  it("CI 对格式、类型、测试和生产构建执行统一门禁", async () => {
    const workflow = await read(".github/workflows/ci.yml");
    for (const command of [
      "npm ci",
      "npm run format:check",
      "npm run typecheck",
      "npm test",
      "npm run build:all",
      "npx playwright install --with-deps chromium",
      "npm run test:e2e",
    ]) {
      expect(workflow).toContain(command);
    }
    expect(workflow).toContain("services:");
    expect(workflow).toContain("postgres:17-alpine");
    expect(workflow).toContain("FORGEX_TEST_DATABASE_URL");
  });

  it("生产 Node 进程解析编译产物，测试环境仍可直接加载源码", async () => {
    for (const packagePath of [
      "packages/contracts/package.json",
      "packages/domain/package.json",
      "packages/extensions/package.json",
      "packages/application/package.json",
      "packages/postgres/package.json",
    ]) {
      const manifest = JSON.parse(await read(packagePath)) as {
        exports?: {
          "."?: { types?: string; development?: string; default?: string };
        };
      };
      expect(manifest.exports?.["."]).toEqual({
        types: "./dist/index.d.ts",
        development: "./src/index.ts",
        default: "./dist/index.js",
      });
    }
  });
});
