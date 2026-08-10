import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  enrollDeviceWorker,
  loadOrCreateAccountFingerprint,
  parseEnrollmentArguments,
  readEnrollmentTokenFile,
} from "../src/enrollment.js";

const roots: string[] = [];

const enrollmentConfig = (root: string) => ({
  schemaVersion: 1,
  controlPlaneUrl: "https://placeholder.example.test",
  connection: null,
  codexHomePath: path.join(root, "codex-home"),
  codexIsolation: {
    launcherPath: path.join(root, "isolation-launcher"),
    launcherSha256: "0".repeat(64),
    isolationKind: "separate_os_identity",
  },
  completionJournalPath: path.join(root, "state", "completion.json"),
  capabilities: ["typescript"],
  projects: [
    {
      projectKey: "22222222-2222-4222-8222-222222222222",
      repositoryKey: "33333333-3333-4333-8333-333333333333",
      repositoryRoot: path.join(root, "repository"),
      worktreeRoot: path.join(root, "worktrees"),
      baseRef: "main",
    },
  ],
  mcpConnections: [
    {
      schemaVersion: 1,
      connectionBindingKey: "55555555-5555-4555-8555-555555555555",
      transport: "streamable_http",
      url: "https://mcp.example.test",
      headers: {},
      allowedTools: ["notifications.send"],
      timeoutMs: 30_000,
    },
  ],
  idlePollIntervalMs: 3_000,
  requestTimeoutMs: 5_000,
  renewIntervalMs: 15_000,
  allowedEnvironmentVariables: [],
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("设备本地接入", () => {
  it("本地身份只生成一次并在后续接入中稳定复用", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-enroll-"));
    roots.push(root);
    const identityPath = path.join(root, "account.identity");
    const allowPrivate = vi.fn(async () => undefined);

    const first = await loadOrCreateAccountFingerprint(
      identityPath,
      allowPrivate,
    );
    const second = await loadOrCreateAccountFingerprint(
      identityPath,
      allowPrivate,
    );
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toBe(first);
  });

  it("两个接入进程并发首次生成时只接受同一个原子身份", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-enroll-"));
    roots.push(root);
    const identityPath = path.join(root, "account.identity");
    const values = await Promise.all([
      loadOrCreateAccountFingerprint(identityPath, async () => undefined),
      loadOrCreateAccountFingerprint(identityPath, async () => undefined),
    ]);
    expect(new Set(values)).toHaveLength(1);
    expect((await readFile(identityPath, "utf8")).trim()).toBe(values[0]);
  });

  it("用短期接入码交换正式连接并原子写回现有配置", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-enroll-"));
    roots.push(root);
    const configPath = path.join(root, "worker.config.json");
    const identityPath = path.join(root, "account.identity");
    await writeFile(configPath, JSON.stringify(enrollmentConfig(root)), "utf8");
    const fetcher = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          accountFingerprint: string;
          capabilities: string[];
        };
        expect(body.accountFingerprint).toMatch(/^[a-f0-9]{64}$/u);
        expect(body.capabilities).toEqual([
          "typescript",
          "55555555-5555-4555-8555-555555555555",
        ]);
        return new Response(
          JSON.stringify({
            data: {
              device: {
                deviceName: "研发电脑 1",
                accountName: "Codex 账户 1",
                status: "已连接",
              },
              connection: {
                schemaVersion: 1,
                tenantKey: "11111111-1111-4111-8111-111111111111",
                workerKey: "22222222-2222-4222-8222-222222222222",
                sessionKey: "a".repeat(43),
                generation: 1,
              },
            },
          }),
          { status: 201 },
        );
      },
    );

    await enrollDeviceWorker({
      controlPlaneUrl: "https://forgex.example.test",
      enrollmentToken: "t".repeat(43),
      configPath,
      identityPath,
      fetcher,
      assertPrivatePath: async () => undefined,
    });

    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      controlPlaneUrl: string;
      connection: { sessionKey: string };
    };
    expect(config.controlPlaneUrl).toBe("https://forgex.example.test");
    expect(config.connection.sessionKey).toBe("a".repeat(43));
  });

  it("交互接入只需公开控制面地址，私有路径可按需覆盖", () => {
    expect(
      parseEnrollmentArguments([
        "--control-plane",
        "https://forgex.example.test",
        "--token-file",
        "C:/private/enrollment.token",
        "--config",
        "C:/private/worker.json",
        "--identity",
        "C:/private/account.identity",
      ]),
    ).toMatchObject({
      controlPlaneUrl: "https://forgex.example.test",
      tokenFile: "C:/private/enrollment.token",
    });
    expect(() => parseEnrollmentArguments(["--token-file", "token"])).toThrow(
      "--control-plane",
    );
  });

  it("接入码只从权限受控的普通文件读取", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-enroll-"));
    roots.push(root);
    const tokenPath = path.join(root, "enrollment.token");
    await writeFile(tokenPath, `${"t".repeat(43)}\n`, "utf8");
    await expect(
      readEnrollmentTokenFile(tokenPath, async () => undefined),
    ).resolves.toBe("t".repeat(43));
  });

  it("控制面超限或畸形响应不会进入内存或泄漏远端文本", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-enroll-"));
    roots.push(root);
    const configPath = path.join(root, "worker.config.json");
    await writeFile(configPath, JSON.stringify(enrollmentConfig(root)), "utf8");
    const invoke = (response: Response) =>
      enrollDeviceWorker({
        controlPlaneUrl: "https://forgex.example.test",
        enrollmentToken: "t".repeat(43),
        configPath,
        identityPath: path.join(root, "account.identity"),
        fetcher: async () => response,
        assertPrivatePath: async () => undefined,
      });

    await expect(
      invoke(
        new Response("", {
          status: 201,
          headers: { "content-length": "1048577" },
        }),
      ),
    ).rejects.toThrow("超过设备协议上限");
    const marker = "Authorization: Bearer local-secret-marker";
    await expect(
      invoke(new Response(`{${marker}`, { status: 201 })),
    ).rejects.toThrow("控制面返回的设备连接格式不正确");
    await expect(
      invoke(new Response(`{${marker}`, { status: 201 })),
    ).rejects.not.toThrow(marker);
  });
});
