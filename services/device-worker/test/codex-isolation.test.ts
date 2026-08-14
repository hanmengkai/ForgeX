import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CODEX_PROGRESS_PREFIX,
  ExternalCodexIsolationRunner,
} from "../src/codex-isolation.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("ExternalCodexIsolationRunner", () => {
  it("从隔离进程 stderr 读取结构化过程事件，同时保留 stdout 执行证明", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-progress-"));
    temporaryRoots.push(root);
    const launcherScript = path.join(root, "launcher.mjs");
    await writeFile(
      launcherScript,
      `let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (request.codex.config.features.code_mode_host !== true) process.exit(31);
if (request.codex.config.features.shell_tool !== false) process.exit(32);
process.stderr.write(${JSON.stringify(CODEX_PROGRESS_PREFIX)} + JSON.stringify({kind:"tool",tool:"search_workspace_text",status:"completed"}) + "\\n");
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  challenge: request.challenge,
  isolationKind: request.isolationKind,
  workspacePath: request.workspacePath,
  protectedPathsHash: request.protectedPathsHash,
  workspaceReadable: true,
  workspaceWritable: true,
  protectedPathsDenied: true,
  controllerIdentitySeparated: true,
  shellToolsDisabled: true,
  controlledWorkspaceToolsOnly: true,
  finalResponse: JSON.stringify({status:"completed",summary:"done",tests:[]}),
  threadId: "thread-local"
}));
`,
      "utf8",
    );
    const runner = new ExternalCodexIsolationRunner({
      launcherPath: process.execPath,
      launcherSha256: createHash("sha256")
        .update(await readFile(process.execPath))
        .digest("hex"),
      launcherArguments: [launcherScript],
      isolationKind: "separate_os_identity",
    });
    const progress: unknown[] = [];

    await expect(
      runner.run({
        workspacePath: path.join(root, "workspace"),
        protectedPaths: [path.join(root, "worker.json")],
        codexHomePath: path.join(root, "codex-home"),
        prompt: "implement",
        outputSchema: { type: "object" },
        reasoningEffort: "high",
        environment: {},
        onProgress: (event) => progress.push(event),
      }),
    ).resolves.toMatchObject({ threadId: "thread-local" });
    expect(progress).toEqual([
      {
        kind: "tool",
        tool: "search_workspace_text",
        status: "completed",
      },
    ]);
  });

  it("把显式文件登录绑定原样交给受信启动器", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-file-auth-"));
    temporaryRoots.push(root);
    const launcherScript = path.join(root, "launcher.mjs");
    const authFilePath = path.join(root, "auth.json");
    await writeFile(authFilePath, '{"tokens":{"access_token":"test"}}', "utf8");
    await writeFile(
      launcherScript,
      `let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (request.authentication.store !== "file") process.exit(21);
if (request.authentication.authFilePath !== ${JSON.stringify(authFilePath)}) process.exit(22);
if (request.codex.config.cli_auth_credentials_store !== "file") process.exit(23);
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  challenge: request.challenge,
  isolationKind: request.isolationKind,
  workspacePath: request.workspacePath,
  protectedPathsHash: request.protectedPathsHash,
  workspaceReadable: true,
  workspaceWritable: true,
  protectedPathsDenied: true,
  controllerIdentitySeparated: true,
  shellToolsDisabled: true,
  controlledWorkspaceToolsOnly: true,
  finalResponse: JSON.stringify({status:"completed",summary:"done",tests:[]}),
  threadId: "thread-file-auth"
}));
`,
      "utf8",
    );
    const runner = new ExternalCodexIsolationRunner({
      launcherPath: process.execPath,
      launcherSha256: createHash("sha256")
        .update(await readFile(process.execPath))
        .digest("hex"),
      launcherArguments: [launcherScript],
      isolationKind: "separate_os_identity",
    });

    await expect(
      runner.run({
        workspacePath: path.join(root, "workspace"),
        protectedPaths: [path.join(root, "worker.json")],
        codexHomePath: path.join(root, "codex-home"),
        authentication: { store: "file", authFilePath },
        prompt: "implement",
        outputSchema: { type: "object" },
        reasoningEffort: "high",
        environment: {},
      }),
    ).resolves.toMatchObject({ threadId: "thread-file-auth" });
  });

  it("同一系统用户在同次执行中仍能读取 Worker 配置时拒绝 Codex 结果", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-isolation-"));
    temporaryRoots.push(root);
    const workspacePath = path.join(root, "workspace");
    const protectedPath = path.join(root, "worker.json");
    const probeScript = path.join(root, "probe.mjs");
    await writeFile(protectedPath, "SESSION_KEY_SHOULD_NOT_BE_READ", "utf8");
    await writeFile(
      probeScript,
      `import { readFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
let protectedReadable = false;
try { readFileSync(request.protectedPaths[0], "utf8"); protectedReadable = true; } catch {}
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  challenge: request.challenge,
  isolationKind: request.isolationKind,
  workspacePath: request.workspacePath,
  protectedPathsHash: request.protectedPathsHash,
  workspaceReadable: true,
  workspaceWritable: true,
  protectedPathsDenied: !protectedReadable,
  controllerIdentitySeparated: false,
  shellToolsDisabled: false,
  controlledWorkspaceToolsOnly: false,
  finalResponse: JSON.stringify({status:"completed",summary:"done",tests:[]}),
  threadId: null
}));
`,
      "utf8",
    );
    const runner = new ExternalCodexIsolationRunner({
      launcherPath: process.execPath,
      launcherSha256: createHash("sha256")
        .update(await readFile(process.execPath))
        .digest("hex"),
      launcherArguments: [probeScript],
      isolationKind: "separate_os_identity",
    });

    await expect(
      runner.run({
        workspacePath,
        protectedPaths: [protectedPath],
        codexHomePath: path.join(root, "codex-home"),
        prompt: "implement",
        outputSchema: { type: "object" },
        reasoningEffort: "high",
        environment: {},
      }),
    ).rejects.toThrow("执行证明");
  });
});
