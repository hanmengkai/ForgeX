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
      localRuntimeConfig,
      productionRuntimeConfig,
      readme,
    ] = await Promise.all([
      read("deploy/compose.yaml"),
      read("Dockerfile"),
      read("apps/web-console/Dockerfile"),
      read(".dockerignore"),
      read("deploy/nginx.conf"),
      read("deploy/config/control-plane.example.json"),
      read("deploy/config/control-plane.production.example.json"),
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
    expect(dockerfile).toContain(
      "COPY services/extension-admin/package.json ./services/extension-admin/package.json",
    );
    expect(webDockerfile).toContain("nginx-unprivileged");
    expect(dockerignore).toContain("**/*.config.json");
    expect(dockerignore).toContain("test-results");
    expect(nginx.slice(0, nginx.indexOf("location /api/"))).not.toContain(
      "Content-Security-Policy",
    );
    expect(nginx.slice(nginx.indexOf("location /api/"))).toContain(
      "Content-Security-Policy",
    );
    expect(localRuntimeConfig).toContain("tokenSha256");
    expect(localRuntimeConfig).toContain(
      '"publicOrigin": "http://localhost:8080"',
    );
    expect(localRuntimeConfig).toContain('"sessionCookieSecure": false');
    expect(productionRuntimeConfig).toContain(
      '"publicOrigin": "https://forgex.example.com"',
    );
    expect(productionRuntimeConfig).toContain('"sessionCookieSecure": true');
    expect(`${localRuntimeConfig}${productionRuntimeConfig}`).not.toMatch(
      /"(?:token|password|sessionKey)"\s*:/u,
    );
    expect(readme).toContain("docker compose");
    expect(readme).toContain("npm run db:migrate");
    expect(readme).toContain("0014_browser_sessions.sql");
    expect(readme).toContain("0015_worker_enrollments.sql");
    expect(readme).toContain("0016_requirement_revisions.sql");
    expect(readme).toContain("0017_delivery_skills.sql");
    expect(readme).toContain("0020_requirement_repository_context.sql");
  });

  it("CI 对格式、类型、测试和生产构建执行统一门禁", async () => {
    const workflow = await read(".github/workflows/ci.yml");
    for (const command of [
      "npm ci",
      "npm run format:check",
      "npm run typecheck",
      "npm run test:coverage",
      "npm run build:all",
      "npm run --workspace @forgex/verification-runner build:verifier",
      "npx playwright install --with-deps chromium",
      "npm run test:e2e",
      "npm run test:e2e:postgres",
    ]) {
      expect(workflow).toContain(command);
    }
    expect(workflow).toContain("services:");
    expect(workflow).toContain("postgres:17-alpine");
    expect(workflow).toContain("FORGEX_TEST_DATABASE_URL");

    const vitestConfig = await read("vitest.config.ts");
    expect(vitestConfig).toContain("thresholds:");
    expect(vitestConfig).toContain("statements: 80");
    expect(vitestConfig).toContain("lines: 80");
    expect(vitestConfig).toContain("functions: 80");
    expect(vitestConfig).toContain("branches: 69");
  });

  it("为 Windows 与 Ubuntu 提供保留数据的一键部署、启动和停止入口", async () => {
    const [
      windowsCommon,
      windowsDeploy,
      windowsStart,
      windowsStop,
      windowsDeployLauncher,
      windowsStartLauncher,
      windowsStopLauncher,
      ubuntuCommon,
      ubuntuDeploy,
      ubuntuStart,
      ubuntuStop,
    ] = await Promise.all([
      read("deploy/windows/common.ps1"),
      read("deploy/windows/deploy.ps1"),
      read("deploy/windows/start.ps1"),
      read("deploy/windows/stop.ps1"),
      read("deploy/windows/deploy.cmd"),
      read("deploy/windows/start.cmd"),
      read("deploy/windows/stop.cmd"),
      read("deploy/ubuntu/common.sh"),
      read("deploy/ubuntu/deploy.sh"),
      read("deploy/ubuntu/start.sh"),
      read("deploy/ubuntu/stop.sh"),
    ]);

    expect(windowsCommon).toContain('"-p", "forgex"');
    expect(windowsCommon).toContain("FORGEX_CONTROL_PLANE_CONFIG_SHA256");
    expect(windowsDeploy).toContain("Get-RandomHex");
    expect(windowsDeploy).toContain("Wait-ForgeXHealth");
    expect(windowsDeploy).toContain("https://");
    expect(windowsStart).toContain('Invoke-ForgeXCompose @("up", "-d")');
    expect(windowsStop).toContain('Invoke-ForgeXCompose @("stop")');
    for (const launcher of [
      windowsDeployLauncher,
      windowsStartLauncher,
      windowsStopLauncher,
    ]) {
      expect(launcher).toContain("-ExecutionPolicy Bypass");
      expect(launcher).toContain("%*");
    }

    expect(ubuntuCommon).toContain("-p forgex");
    expect(ubuntuCommon).toContain("FORGEX_CONTROL_PLANE_CONFIG_SHA256");
    expect(ubuntuDeploy).toContain("set -Eeuo pipefail");
    expect(ubuntuDeploy).toContain("generate_random_hex");
    expect(ubuntuDeploy).toContain("wait_for_health");
    expect(ubuntuDeploy).toContain("https://");
    expect(ubuntuStart).toContain("compose up -d");
    expect(ubuntuStop).toContain("compose stop");

    for (const script of [
      windowsCommon,
      windowsDeploy,
      windowsStart,
      windowsStop,
      ubuntuCommon,
      ubuntuDeploy,
      ubuntuStart,
      ubuntuStop,
    ]) {
      expect(script).not.toMatch(/down\s+(?:--volumes|-v)/u);
    }
  });

  it("仓库交付可构建且不执行候选脚本的独立验证镜像", async () => {
    const [dockerfile, driver, runnerPackage, readme] = await Promise.all([
      read("services/verification-runner/verifier-image/Dockerfile"),
      read("services/verification-runner/verifier-image/node-quality.mjs"),
      read("services/verification-runner/package.json"),
      read("README.md"),
    ]);

    expect(dockerfile).toContain("USER 65532:65532");
    expect(dockerfile).toContain("/forgex-verifier/node-quality");
    expect(dockerfile).toMatch(
      /^FROM node:24\.18\.1-bookworm-slim@sha256:[a-f0-9]{64}$/mu,
    );
    expect(driver).not.toContain("npm test");
    expect(driver).not.toContain("npm run");
    expect(runnerPackage).toContain('"build:verifier"');
    expect(runnerPackage).toContain('"admin"');
    expect(readme).toContain("runner.bootstrap.example.json");
    expect(readme).toContain("runner.plan.example.json");
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
