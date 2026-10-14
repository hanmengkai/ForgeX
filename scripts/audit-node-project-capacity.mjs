import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { PostgresLifecycleArtifactStore } from "../packages/postgres/dist/index.js";
import { NodeProjectLifecyclePipeline } from "../services/device-worker/dist/lifecycle-node-project.js";
import {
  savePrivateJson,
  savePrivateBytes,
} from "../services/device-worker/dist/lifecycle-transfer.js";
import { assertLifecyclePrivatePath } from "../services/device-worker/dist/lifecycle-runtime.js";

// 容量补测使用同一已批准制品及真实运行时，在独立测试进程中预置满额状态。
export async function auditNodeCapacity(root, databaseUrl) {
  root = path.resolve(root);
  const controllerFile = path.join(root, "controller.json"),
    reportFile = path.join(root, "verification.json"),
    configFile = path.join(root, "workers/staging/config.json");
  for (const file of [controllerFile, reportFile, configFile])
    await assertLifecyclePrivatePath(file);
  const url = new URL(databaseUrl);
  if (
    !url.pathname.endsWith("_test") ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error("容量补测仅允许本机隔离测试数据库");
  const controller = JSON.parse(await readFile(controllerFile, "utf8")),
    report = JSON.parse(await readFile(reportFile, "utf8"));
  if (!/^forgex_node_[a-f0-9]{32}$/u.test(controller.schema))
    throw new Error("容量补测数据库范围不正确");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${controller.schema}`,
    max: 2,
  });
  const jobKey = randomUUID(),
    auditRoot = path.join(root, "capacity-audit"),
    pipeline = new NodeProjectLifecyclePipeline({
      ...config.nodeProject,
      root: auditRoot,
    });
  let deployed = false;
  try {
    const state = (
      await pool.query("SELECT state FROM forgex_lifecycle_states")
    ).rows[0].state;
    const workflow = state.workflows.find(
      (w) => w.workflowKey === report.workflow.workflowKey,
    );
    assert.equal(workflow.stage, "release_approval");
    const original = workflow.jobs.find(
      (j) => j.stage === "staging_deploy" && j.status === "succeeded",
    );
    assert.ok(original);
    const code = original.input.artifacts.find(
      (a) => a.output.kind === "code",
    ).output;
    const envelope = await new PostgresLifecycleArtifactStore(pool).get(
      {
        tenantKey: workflow.tenantKey,
        projectKey: workflow.projectKey,
        repositoryKey: workflow.repositoryKey,
      },
      code.artifactDigest,
      code.commitSha,
    );
    assert.ok(envelope);
    await savePrivateBytes(
      path.join(auditRoot, "artifacts", `${code.artifactDigest}.mjs`),
      Buffer.from(envelope.bytesBase64, "base64"),
    );
    const tasks = Array.from({ length: 1000 }, (_, index) => ({
      id: randomUUID(),
      title: `满额任务 ${index}`,
      status: "todo",
      requestKey: randomUUID(),
    }));
    await savePrivateJson(
      path.join(auditRoot, "environments", jobKey, "state.json"),
      { schemaVersion: 1, state: { tasks } },
    );
    const result = await pipeline.execute(
      { ...original, jobKey },
      new AbortController().signal,
    );
    assert.equal(result.status, "succeeded");
    deployed = true;
    const origin = result.output.url;
    const post = async (title, requestKey) => {
      const response = await fetch(origin + "/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, requestKey }),
        signal: AbortSignal.timeout(3000),
      });
      return { status: response.status, body: await response.json() };
    };
    const full = await post("新增满额任务", randomUUID());
    assert.equal(full.status, 409);
    assert.match(full.body.error, /[^\x00-\x7F]/u);
    const repeated = await post(tasks[0].title, tasks[0].requestKey);
    assert.equal(repeated.status, 200);
    assert.deepEqual(repeated.body, tasks[0]);
    assert.equal((await post("冲突标题", tasks[0].requestKey)).status, 409);
    assert.deepEqual(
      (await (await fetch(origin + "/tasks")).json()).tasks,
      tasks,
    );
    report.capacityAudit = {
      schemaVersion: 1,
      isolated: true,
      commitSha: code.commitSha,
      artifactDigest: code.artifactDigest,
      checks: [
        { name: "满额拒绝新任务且保留原数据", passed: true },
        { name: "满额重复提交仍返回原任务", passed: true },
        { name: "满额同键异内容仍拒绝覆盖", passed: true },
      ],
    };
    await savePrivateJson(reportFile, report);
    console.log("同一已批准制品的 3 项容量边界补测通过");
    return report.capacityAudit;
  } finally {
    if (deployed) await pipeline.stopDeployment(jobKey);
    await pool.end();
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve("scripts/audit-node-project-capacity.mjs")
) {
  const url =
    process.env.FORGEX_TEST_DATABASE_URL ??
    JSON.parse(
      await readFile(".forgex-local/node-p0-tools/connection.json", "utf8"),
    ).connectionString;
  await auditNodeCapacity(process.argv[2], url);
}
