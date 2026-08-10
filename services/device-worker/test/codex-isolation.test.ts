import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExternalCodexIsolationRunner } from "../src/codex-isolation.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("ExternalCodexIsolationRunner", () => {
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
