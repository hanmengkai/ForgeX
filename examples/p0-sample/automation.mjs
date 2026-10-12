import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HashedLifecycleExecutorAuthenticator } from "../../apps/control-plane-api/dist/lifecycle-api.js";
import {
  HttpLifecycleClient,
  LifecycleExecutorRuntime,
  MemoryLifecycleJournal,
} from "../../services/device-worker/dist/lifecycle-runtime.js";
import { SampleLifecycleAdapter } from "../../services/device-worker/dist/lifecycle-sample-adapter.js";
import { createAiSampleAdapter } from "./ai-adapter.mjs";

export async function createSampleAutomation({
  tenantKey,
  projectKey,
  repositoryKey,
}) {
  const labels = {
    requester: "需求方",
    product_owner: "产品负责人",
    developer: "研发负责人",
    tester: "测试负责人",
    test_ops: "测试运维",
    production_ops: "生产运维",
  };
  const accounts = Object.entries(labels).map(([role, label]) => ({
    accountKey: randomUUID(),
    tenantKey,
    username: `p0.${role}`,
    actorName: `样板${label}`,
    roles: [role],
    password: "P0-Sample-2026!",
    enabled: true,
    revision: 1,
  }));
  const definitions = [
    ["requirements_ai", "design_ai", "development"],
    ["testing"],
    ["staging_deploy"],
    ["production_deploy", "production_rollback"],
  ];
  const executors = definitions.map((capabilities) => {
    const pair = generateKeyPairSync("ed25519"),
      token = randomUUID();
    return {
      token,
      privateKey: pair.privateKey,
      executor: {
        executorKey: randomUUID(),
        tenantKey,
        projectKey,
        repositoryKey,
        capabilities,
        publicKeyBase64: pair.publicKey
          .export({ type: "spki", format: "der" })
          .toString("base64"),
      },
    };
  });
  const root = await mkdtemp(
    path.join(
      await (await import("node:fs/promises")).realpath(tmpdir()),
      "forgex-p0-console-",
    ),
  );
  const ai =
    process.env.FORGEX_SAMPLE_MODE === "ai"
      ? await createAiSampleAdapter({
          root,
          projectKey,
          repositoryKey,
          onAgentResult: async (record) =>
            console.log(`真实 Agent 已完成：${record.stage}`),
        })
      : null;
  const adapter =
    ai?.pipeline ??
    new SampleLifecycleAdapter({
      root,
      sourcePath: fileURLToPath(new URL("./app.mjs", import.meta.url)),
    });
  let stopped = false,
    running = null,
    timer,
    heartbeatTimer;
  return {
    accounts,
    authenticator: new HashedLifecycleExecutorAuthenticator(
      executors.map((item) => ({
        tokenSha256: createHash("sha256").update(item.token).digest("hex"),
        executor: item.executor,
        provider:
          ai &&
          item.executor.capabilities.some((c) =>
            ["requirements_ai", "testing"].includes(c),
          )
            ? "codex"
            : "sample",
      })),
    ),
    start(origin) {
      const clients = executors.map(
        (item) => new HttpLifecycleClient({ origin, token: item.token }),
      );
      const runtimes = executors.map(
        (item, index) =>
          new LifecycleExecutorRuntime({
            client: clients[index],
            adapter: ai?.adapter ?? adapter,
            journal: new MemoryLifecycleJournal(),
            privateKey: item.privateKey,
            onExecutionError: (message) =>
              console.error(`本地样板执行诊断：${message}`),
          }),
      );
      const reportHeartbeat = () =>
        Promise.all(
          clients.map(async (client, index) =>
            client.heartbeat({
              schemaVersion: 1,
              displayName: [
                "需求设计与开发执行器",
                "独立测试执行器",
                "测试环境执行器",
                "发布与恢复执行器",
              ][index],
              provider: ai && [0, 1].includes(index) ? "codex" : "sample",
              loginState:
                ai && [0, 1].includes(index) ? "unknown" : "not_required",
              executionState:
                (await runtimes[index].options.journal.load())?.phase ===
                "completed"
                  ? "awaiting_confirmation"
                  : (await runtimes[index].options.journal.load())
                    ? "executing"
                    : "idle",
            }),
          ),
        ).catch(() => {});
      void reportHeartbeat();
      heartbeatTimer = setInterval(() => void reportHeartbeat(), 15000);
      const poll = async () => {
        if (stopped) return;
        try {
          for (const runtime of runtimes) {
            if (stopped) break;
            await runtime.tick();
          }
        } catch {
          console.error("隔离样板执行失败，请在完整交付页面核对阻塞原因");
        } finally {
          if (!stopped)
            timer = setTimeout(() => {
              running = poll();
            }, 200);
        }
      };
      running = poll();
    },
    async close() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(heartbeatTimer);
      await running;
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
