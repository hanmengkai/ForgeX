import { generateKeyPairSync, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  StaticVerificationSuitePlanProvider,
  loadVerificationRunnerConfig,
  verificationSuitePlanHash,
  type VerificationRunnerTarget,
  type VerificationSuitePlan,
} from "../src/index.js";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);

const makeWindowsPrivate = async (target: string): Promise<void> => {
  if (process.platform !== "win32") return;
  const systemRoot = process.env.SystemRoot!;
  const powershellPath = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = String.raw`
$acl = Get-Acl -LiteralPath $env:FORGEX_ACL_TEST_TARGET
$acl.SetAccessRuleProtection($true, $false)
$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administrators = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
foreach ($identity in @($current, $system, $administrators)) {
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', $inheritance, $propagation, $allow))
}
Set-Acl -LiteralPath $env:FORGEX_ACL_TEST_TARGET -AclObject $acl
`;
  await execFileAsync(
    powershellPath,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { SystemRoot: systemRoot, FORGEX_ACL_TEST_TARGET: target },
      windowsHide: true,
    },
  );
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

const target: VerificationRunnerTarget = {
  requirementKey: "60000000-0000-4000-8000-000000000006",
  requirementRevision: 2,
  repositoryKey: "30000000-0000-4000-8000-000000000003",
  gitHashAlgorithm: "sha1",
  commitSha: "a".repeat(40),
  title: "访客预约",
  goal: "让访客可以提前预约",
  acceptanceCriteria: [
    {
      criterionKey: "70000000-0000-4000-8000-000000000007",
      title: "预约成功",
      description: "提交后可以看到预约结果",
      priority: "must",
    },
  ],
  previewArtifact: null,
};

const plan: VerificationSuitePlan = {
  schemaVersion: 1,
  planKey: "node-quality",
  planVersion: 1,
  repositoryKey: target.repositoryKey,
  requirementKey: target.requirementKey,
  requirementRevision: target.requirementRevision,
  gitHashAlgorithm: target.gitHashAlgorithm,
  commitSha: target.commitSha,
  suites: [
    {
      suiteKey: "unit",
      name: "单元测试",
      criterionKeys: [target.acceptanceCriteria[0]!.criterionKey],
      execution: {
        image: `registry.example.test/forgex/node@sha256:${"a".repeat(64)}`,
        command: ["/forgex-verifier/node-quality"],
        timeoutMs: 120_000,
      },
    },
  ],
};

const fixture = async () => {
  const root = path.join(os.homedir(), `.forgex-runner-config-${randomUUID()}`);
  temporaryRoots.push(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(root, 0o700);
  else await makeWindowsPrivate(root);
  const repositoryRoot = path.join(root, "repository");
  const workspaceRoot = path.join(root, "workspaces");
  await mkdir(repositoryRoot);
  await mkdir(workspaceRoot, { mode: 0o700 });
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = path.join(root, "runner-private-key.pem");
  const sessionKeyPath = path.join(root, "runner-session.key");
  const integrityKeyPath = path.join(root, "journal-integrity.key");
  const configPath = path.join(root, "runner.config.json");
  const journalPath = path.join(root, "verification-journal.json");
  const dockerPath = path.join(root, "docker-fixture");
  const gitPath = path.join(root, "git-fixture");
  await Promise.all([
    writeFile(
      privateKeyPath,
      privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    ),
    writeFile(sessionKeyPath, "runner_session_key_1234567890", { mode: 0o600 }),
    writeFile(integrityKeyPath, Buffer.alloc(32, 0x5a).toString("base64"), {
      mode: 0o600,
    }),
    writeFile(dockerPath, "docker", { mode: 0o700 }),
    writeFile(gitPath, "git", { mode: 0o700 }),
  ]);
  const config = {
    schemaVersion: 1,
    controlPlaneUrl: "https://forgex.example.test",
    sessionKeyPath,
    privateKeyPath,
    journalIntegrityKeyPath: integrityKeyPath,
    journalPath,
    scope: {
      tenantKey: "10000000-0000-4000-8000-000000000001",
      projectKey: "20000000-0000-4000-8000-000000000002",
      repositoryKey: target.repositoryKey,
      runnerKey: "40000000-0000-4000-8000-000000000004",
      keyId: "50000000-0000-4000-8000-000000000005",
    },
    repositoryRoot,
    workspaceRoot,
    gitCommandPath: gitPath,
    gitCommandSha256: "b".repeat(64),
    dockerCommandPath: dockerPath,
    dockerCommandSha256: "c".repeat(64),
    containerUser: "65532:65532",
    plans: [plan],
    trustedPlanAnchors: [
      {
        repositoryKey: plan.repositoryKey,
        planKey: plan.planKey,
        planVersion: plan.planVersion,
        planHash: verificationSuitePlanHash(plan),
      },
    ],
    idlePollIntervalMs: 3_000,
    requestTimeoutMs: 5_000,
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  if (process.platform !== "win32") {
    await Promise.all(
      [
        configPath,
        privateKeyPath,
        sessionKeyPath,
        integrityKeyPath,
        dockerPath,
        gitPath,
      ].map((file) => chmod(file, 0o600)),
    );
  }
  return { root, configPath, sessionKeyPath };
};

describe("Verification Runner config", () => {
  it("只从受保护文件读取会话、签名私钥和日志完整性密钥", async () => {
    const { configPath } = await fixture();
    const config = await loadVerificationRunnerConfig(configPath);

    expect(config.sessionKey).toBe("runner_session_key_1234567890");
    expect(config.journalIntegrityKey).toEqual(new Uint8Array(32).fill(0x5a));
    expect(config.privateKey.asymmetricKeyType).toBe("ed25519");
    expect(config.scope.repositoryKey).toBe(target.repositoryKey);
    expect(config.containerUser).toBe("65532:65532");
    expect(JSON.stringify(config)).not.toContain("PRIVATE KEY");
  }, 15_000);

  it.runIf(process.platform !== "win32")(
    "拒绝可被其他本机用户读取的 Runner 会话文件",
    async () => {
      const { configPath, sessionKeyPath } = await fixture();
      await chmod(sessionKeyPath, 0o644);
      await expect(loadVerificationRunnerConfig(configPath)).rejects.toThrow(
        "仅允许",
      );
    },
  );

  it("静态计划提供者只返回与权威任务完全相同的不可变计划", async () => {
    const provider = new StaticVerificationSuitePlanProvider([plan]);
    await expect(provider.planFor(target)).resolves.toEqual(plan);
    await expect(
      provider.planFor({ ...target, commitSha: "b".repeat(40) }),
    ).rejects.toThrow("验证计划");
  });

  it("仓库内示例配置的计划摘要可以直接通过完整性核对", async () => {
    const example = JSON.parse(
      await readFile(
        path.resolve("services/verification-runner/runner.config.example.json"),
        "utf8",
      ),
    ) as {
      plans: VerificationSuitePlan[];
      trustedPlanAnchors: Array<{ planHash: string }>;
    };
    expect(example.trustedPlanAnchors[0]!.planHash).toBe(
      verificationSuitePlanHash(example.plans[0]!),
    );
  });
});
