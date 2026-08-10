import path from "node:path";

import { RunnerControlPlaneClient } from "./control-plane-client.js";
import { DockerVerificationSandbox } from "./docker-verification-sandbox.js";
import { GitVerificationWorkspaceProvider } from "./git-verification-workspace.js";
import { FileVerificationJournal } from "./journal.js";
import {
  loadVerificationRunnerConfig,
  StaticVerificationSuitePlanProvider,
} from "./runner-config.js";
import { runVerificationRunnerLoop } from "./runner-loop.js";
import { VerificationRunnerRuntime } from "./runtime.js";
import { Ed25519RunnerEvidenceSigner } from "./signer.js";
import { FixedSuiteVerificationEngine } from "./verification-engine.js";

const configPath = process.env.FORGEX_RUNNER_CONFIG;
if (!configPath) {
  throw new Error("请通过 FORGEX_RUNNER_CONFIG 指定独立 Runner 配置文件");
}

const config = await loadVerificationRunnerConfig(path.resolve(configPath));
const journal = await FileVerificationJournal.open(config.journalPath);
const abort = new AbortController();
process.once("SIGINT", () => abort.abort("SIGINT"));
process.once("SIGTERM", () => abort.abort("SIGTERM"));

try {
  const sandbox = new DockerVerificationSandbox({
    dockerCommandPath: config.dockerCommandPath,
    dockerCommandSha256: config.dockerCommandSha256,
    containerUser: config.containerUser,
    runnerKey: config.scope.runnerKey,
  });
  await sandbox.initialize();
  const runtime = new VerificationRunnerRuntime({
    scope: config.scope,
    controlPlane: new RunnerControlPlaneClient({
      baseUrl: config.controlPlaneUrl,
      sessionKey: config.sessionKey,
      requestTimeoutMs: config.requestTimeoutMs,
    }),
    verifier: new FixedSuiteVerificationEngine({
      workspace: new GitVerificationWorkspaceProvider({
        repositories: [
          {
            repositoryKey: config.scope.repositoryKey,
            repositoryRoot: config.repositoryRoot,
          },
        ],
        workspaceRoot: config.workspaceRoot,
        gitCommandPath: config.gitCommandPath,
        gitCommandSha256: config.gitCommandSha256,
      }),
      sandbox,
      planProvider: new StaticVerificationSuitePlanProvider(config.plans),
      trustedPlanAnchors: config.trustedPlanAnchors,
    }),
    signer: new Ed25519RunnerEvidenceSigner({
      runnerKey: config.scope.runnerKey,
      keyId: config.scope.keyId,
      privateKey: config.privateKey,
    }),
    journal,
    journalIntegrityKey: config.journalIntegrityKey,
  });

  await runVerificationRunnerLoop({
    runtime,
    idlePollIntervalMs: config.idlePollIntervalMs,
    signal: abort.signal,
    onResult: (result) => {
      if (result.kind === "submitted") {
        process.stdout.write(`独立验证已提交：${result.title}\n`);
      } else if (result.kind === "verification_failed") {
        process.stdout.write(`独立验证未通过：${result.title}\n`);
      }
    },
    onError: () => {
      process.stderr.write("独立 Runner 暂未完成任务，将在稍后安全重试\n");
    },
  });
} finally {
  await journal.close();
}
