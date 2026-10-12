import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  initializeDurableSample,
  setDurableOrigin,
} from "../examples/p0-sample/durable-stack.mjs";
import { savePrivateJson } from "../services/device-worker/dist/lifecycle-transfer.js";
import { SampleLifecycleAdapter } from "../services/device-worker/dist/lifecycle-sample-adapter.js";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await pause(100);
  }
  throw new Error("隔离验收等待超时");
}
async function stop(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  await Promise.race([
    exited,
    pause(5000).then(() => {
      child.kill("SIGKILL");
    }),
  ]);
}
async function start(command, args, environment = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c) => {
    output += String(c);
  });
  child.stderr.on("data", (c) => {
    output += String(c);
  });
  child.on("error", () => {});
  await until(() => {
    if (child.exitCode !== null)
      throw new Error(`隔离组件启动失败：${output.slice(-1500)}`);
    return output.includes("已就绪");
  });
  return { child, output: () => output };
}
export async function verifyDurableSample({ root, mode = "codex" }) {
  root = path.resolve(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const { manifest } = await initializeDurableSample({ root, mode });
  let controller,
    controllerOrigin,
    proxyOrigin,
    proxy,
    offline = false,
    dropUpload = true,
    dropProduction = true,
    uploadDrops = 0,
    artifactDownloads = 0;
  const workers = new Map(),
    completions = [],
    diagnostics = [];
  const configPath = (name) => path.join(root, "workers", name, "config.json");
  const journalPath = (name) =>
    path.join(root, "workers", name, "journal", "pending.json");
  const startController = async (port) => {
    const result = await start(
      process.execPath,
      ["examples/p0-sample/durable-control-plane.mjs", root],
      { FORGEX_SAMPLE_MODE: mode, FORGEX_SAMPLE_PORT: String(port) },
    );
    controller = result.child;
    controllerOrigin = /http:\/\/127\.0\.0\.1:\d+/u.exec(result.output())?.[0];
    assert.ok(controllerOrigin);
    return result;
  };
  const startWorker = async (name) => {
    const result = await start(process.execPath, [
      "services/device-worker/dist/lifecycle-main.js",
      configPath(name),
    ]);
    workers.set(name, result.child);
    diagnostics.push({ name, output: result.output });
    return result.child;
  };
  const request = async (role, method, endpoint, body) => {
    const person = manifest.people.find((p) => p.roles.includes(role));
    assert.ok(person);
    const response = await fetch(new URL(endpoint, controllerOrigin), {
      method,
      headers: {
        authorization: `Bearer ${person.token}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json();
    assert.ok(response.ok, JSON.stringify(payload));
    return payload.data;
  };
  const get = (key) => request("developer", "GET", `/api/v2/lifecycle/${key}`);
  const waitStage = (key, stage) =>
    until(
      async () => {
        const flow = await get(key);
        if (flow.blockedReason)
          throw new Error(
            `阶段阻塞：${flow.blockedReason}\n${diagnostics.map((d) => d.output().slice(-1500)).join("\n")}`,
          );
        return flow.stage === stage && flow;
      },
      mode === "codex" ? 20 * 60 * 1000 : 30000,
    );
  const approve = async (key, role) => {
    const flow = await get(key);
    return request(role, "POST", `/api/v2/lifecycle/${key}/decisions`, {
      schemaVersion: 2,
      requestKey: randomUUID(),
      expectedVersion: flow.version,
      role,
      decision: "approve",
      reason: "隔离验收中的角色确认输入：已核对本轮结果",
    });
  };
  let report;
  try {
    await startController(0);
    const originalControllerPid = controller.pid;
    proxy = createServer(async (req, res) => {
      try {
        if (offline) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "隔离验收模拟断网" }));
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const response = await fetch(new URL(req.url, controllerOrigin), {
          method: req.method,
          headers: {
            authorization: req.headers.authorization,
            "content-type": "application/json",
          },
          ...(body.length ? { body } : {}),
          signal: AbortSignal.timeout(10000),
        });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (req.url.endsWith("/artifacts/read") && response.ok)
          artifactDownloads++;
        if (req.url.endsWith("/artifacts") && response.ok && dropUpload) {
          dropUpload = false;
          uploadDrops++;
          res.destroy();
          return;
        }
        if (req.url === "/api/v2/executor/complete") {
          const completion = JSON.parse(body.toString("utf8"));
          if (
            completion.payload.result.output?.kind === "deployment" &&
            completion.payload.result.output.environment === "production"
          ) {
            completions.push({
              body: body.toString("utf8"),
              accepted: response.ok,
            });
            if (dropProduction && response.ok) {
              dropProduction = false;
              offline = true;
              res.destroy();
              return;
            }
          }
        }
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(bytes);
      } catch {
        res.destroy();
      }
    });
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
    proxyOrigin = `http://127.0.0.1:${proxy.address().port}`;
    await setDurableOrigin(root, proxyOrigin);
    for (const name of ["agent", "test", "staging", "production"])
      await startWorker(name);
    const requester = manifest.people.find((p) =>
      p.roles.includes("requester"),
    );
    const created = await request("requester", "POST", "/api/v2/lifecycle", {
      schemaVersion: 2,
      requestKey: randomUUID(),
      projectKey: manifest.projectKey,
      repositoryKey: manifest.repositoryKey,
      requesterKey: requester.actorKey,
      title: "访客预约",
      brief: "访客提交预约并获得可查询编号，重复请求保持幂等",
    });
    const key = created.workflowKey;
    await waitStage(key, "requirements_review");
    await approve(key, "product_owner");
    await approve(key, "requester");
    const before = await waitStage(key, "design_review");
    const port = Number(new URL(controllerOrigin).port);
    await stop(controller, "SIGKILL");
    await startController(port);
    const after = await get(key);
    assert.deepEqual(after, before);
    assert.notEqual(controller.pid, originalControllerPid);
    await pause(1200);
    assert.equal((await get(key)).stage, "design_review");
    assert.ok(!(await get(key)).artifacts.some((a) => a.kind === "code"));
    const unauthorized = await fetch(
      new URL(`/api/v2/lifecycle/${key}/decisions`, controllerOrigin),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${requester.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 2,
          requestKey: randomUUID(),
          expectedVersion: after.version,
          role: "developer",
          decision: "approve",
          reason: "隔离验收：禁止代替研发审核设计",
        }),
      },
    );
    assert.equal(unauthorized.status, 409);
    await approve(key, "developer");
    await waitStage(key, "code_review");
    assert.equal(uploadDrops, 1);
    await approve(key, "developer");
    await waitStage(key, "test_review");
    await approve(key, "tester");
    const staging = await waitStage(key, "staging_acceptance");
    const stagingUrl = staging.artifacts.find(
      (a) => a.kind === "deployment",
    ).url;
    const appointment = await fetch(`${stagingUrl}/appointments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "独立执行器验收访客",
        visitAt: "2030-01-01T10:00:00Z",
        requestKey: randomUUID(),
      }),
    });
    assert.equal(appointment.status, 201);
    await approve(key, "requester");
    await approve(key, "developer");
    await approve(key, "production_ops");
    assert.equal((await get(key)).stage, "release_approval");
    await pause(1200);
    assert.equal(completions.length, 0);
    await approve(key, "requester");
    await until(async () => {
      try {
        const pending = JSON.parse(
          await readFile(journalPath("production"), "utf8"),
        );
        return offline && pending.phase === "completed";
      } catch {
        return false;
      }
    });
    const deploymentFile = path.join(
      root,
      "workers",
      "production",
      "pipeline",
      "environments",
      `production-${manifest.projectKey}-${manifest.repositoryKey}`,
      "deployment.json",
    );
    const published = JSON.parse(await readFile(deploymentFile, "utf8"));
    const originalWorkerPid = workers.get("production").pid;
    await stop(workers.get("production"), "SIGKILL");
    const restartedWorker = await startWorker("production");
    assert.notEqual(restartedWorker.pid, originalWorkerPid);
    await pause(1200);
    const pending = JSON.parse(
      await readFile(journalPath("production"), "utf8"),
    );
    assert.equal(pending.phase, "completed");
    assert.equal(completions.length, 1);
    offline = false;
    await until(async () => {
      try {
        await readFile(journalPath("production"));
        return false;
      } catch (error) {
        return error.code === "ENOENT";
      }
    });
    const recovered = JSON.parse(await readFile(deploymentFile, "utf8"));
    assert.deepEqual(recovered, published);
    assert.equal(completions.length, 2);
    assert.equal(completions[0].body, completions[1].body);
    assert.ok(completions.every((c) => c.accepted));
    assert.equal((await get(key)).stage, "online_acceptance");
    for (const role of ["developer", "production_ops", "requester"])
      await approve(key, role);
    assert.equal((await get(key)).stage, "closed");
    const bug = await request(
      "requester",
      "POST",
      `/api/v2/lifecycle/${key}/bugs`,
      {
        schemaVersion: 2,
        requestKey: randomUUID(),
        title: "隔离验收 Bug 入口",
        description: "验证关闭需求仍可记录后续问题",
        severity: "minor",
      },
    );
    assert.equal(bug.status, "open");
    const sessions = [];
    for (const name of ["agent", "test"]) {
      const dir = path.join(root, "workers", name, "journal", "model-results");
      try {
        for (const file of await readdir(dir))
          sessions.push(
            JSON.parse(await readFile(path.join(dir, file), "utf8")),
          );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (mode === "codex") {
      assert.equal(sessions.length, 4);
      assert.equal(new Set(sessions.map((s) => s.threadId)).size, 4);
      assert.ok(sessions.every((s) => s.threadId));
    }
    report = {
      schemaVersion: 1,
      modelMode: mode,
      stage: "closed",
      controllerRestarted: true,
      workerRestarted: true,
      offlineReceiptPreserved: true,
      artifactUploadRecovered: true,
      independentDesignReview: true,
      bugEntry: true,
      artifactDownloads,
      uniquePublishCount: new Set(
        completions.map(
          (c) => JSON.parse(c.body).payload.result.output.deploymentKey,
        ),
      ).size,
      confirmationAttempts: completions.length,
      sameSignedCompletion: completions[0].body === completions[1].body,
      modelSessions: sessions.map((s) => ({
        stage: s.stage,
        threadId: s.threadId,
      })),
      deployment: {
        artifactDigest: published.artifactDigest,
        commitSha: published.commitSha,
        environmentKey: published.environmentKey,
        pid: published.pid,
      },
      workflow: await get(key),
    };
    await savePrivateJson(path.join(root, "verification.json"), report);
    return report;
  } finally {
    offline = false;
    for (const child of workers.values()) await stop(child);
    if (proxy) await new Promise((r) => proxy.close(r));
    await stop(controller);
    for (const name of ["agent", "test", "staging", "production"]) {
      const adapter = new SampleLifecycleAdapter({
        root: path.join(root, "workers", name, "pipeline"),
        sourcePath: path.join(cwd, "examples/p0-sample/app.mjs"),
        durableDeployments: true,
      });
      await adapter.close();
    }
    await savePrivateJson(
      path.join(root, "component-diagnostics.json"),
      diagnostics.map((d) => ({ name: d.name, output: d.output() })),
    );
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = path.join(
    cwd,
    ".forgex-local",
    "p0-durable",
    new Date().toISOString().replaceAll(":", "-"),
  );
  console.log(`持久化独立 Codex 执行器验收证据：${root}`);
  const timer = setInterval(
    () =>
      console.log("隔离自动化与故障恢复验收仍在运行，审批由测试角色输入提供"),
    30000,
  );
  timer.unref();
  try {
    const report = await verifyDurableSample({
      root,
      mode: process.argv.includes("--fixture") ? "fixture" : "codex",
    });
    console.log(
      JSON.stringify({
        stage: report.stage,
        modelMode: report.modelMode,
        modelSessions: report.modelSessions.length,
        uniquePublishCount: report.uniquePublishCount,
        artifactDownloads: report.artifactDownloads,
      }),
    );
  } finally {
    clearInterval(timer);
  }
}
