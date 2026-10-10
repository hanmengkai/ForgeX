import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { SampleLifecycleAdapter } from "../../services/device-worker/dist/lifecycle-sample-adapter.js";
import { CodexLifecycleAdapter } from "../../services/device-worker/dist/lifecycle-codex-adapter.js";
import { CurrentUserCodexRunner } from "../../services/device-worker/dist/current-user-codex.js";
import { LocalGitCommandRunner } from "../../services/device-worker/dist/workspace.js";

export async function createAiSampleAdapter({
  root,
  projectKey,
  repositoryKey,
  onAgentResult,
}) {
  root = await realpath(root);
  if (process.platform !== "darwin")
    throw new Error("当前真实 AI 样板仅支持经过验证的 macOS 系统沙箱");
  const repositoryRoot = path.join(root, "ai-repository");
  await mkdir(repositoryRoot, { mode: 0o700 });
  const contract = await readFile(
    new URL("./business-contract.md", import.meta.url),
    "utf8",
  );
  await writeFile(path.join(repositoryRoot, "README.md"), contract, {
    mode: 0o600,
  });
  await writeFile(
    path.join(repositoryRoot, "appointment.js"),
    '// 请由开发 Agent 按已批准需求与设计实现业务函数。\nfunction handleAppointment(input) { throw new Error("业务尚未实现"); }\n',
    { mode: 0o600 },
  );
  const git = new LocalGitCommandRunner();
  await git.run(["init", "-q", "-b", "main", repositoryRoot]);
  await git.run(["-C", repositoryRoot, "add", "README.md", "appointment.js"]);
  await git.run([
    "-C",
    repositoryRoot,
    "-c",
    "user.name=ForgeX 隔离样板",
    "-c",
    "user.email=ai-sample@forgex.local",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-qm",
    "初始化：仅提供业务协议，等待真实 Agent 实现",
  ]);
  const pipeline = new SampleLifecycleAdapter({
    root,
    sourcePath: fileURLToPath(new URL("./app.mjs", import.meta.url)),
    businessRuntimePath: fileURLToPath(
      new URL("./business-runtime.mjs", import.meta.url),
    ),
  });
  const records = [];
  const adapter = new CodexLifecycleAdapter({
    project: {
      projectKey,
      repositoryKey,
      repositoryRoot,
      worktreeRoot: path.join(root, "ai-worktrees"),
      baseRef: "main",
      reasoningEffort: "low",
      ...(process.env.FORGEX_CODEX_MODEL
        ? { model: process.env.FORGEX_CODEX_MODEL }
        : {}),
    },
    runner: new CurrentUserCodexRunner(),
    codexHomePath: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    protectedPaths: [repositoryRoot],
    pipeline,
    testingAgent: true,
    allowedDevelopmentFiles: ["appointment.js"],
    instructions: `当前是隔离样板协议，必须遵守以下能力和验收范围：\n${contract}`,
    onAgentResult: async (stage, response) => {
      const record = {
        stage,
        threadId: response.threadId,
        output: JSON.parse(response.finalResponse),
        at: new Date().toISOString(),
      };
      records.push(record);
      await onAgentResult?.(record);
    },
  });
  return { adapter, pipeline, records, root };
}
