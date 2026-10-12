import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AccountAdministrationService,
  InMemoryAccountRepository,
  InMemoryExtensionCatalogRepository,
  InMemoryKnowledgeBaseRepository,
  InMemoryMcpInputSchemaStore,
  InMemoryMcpInvocationRepository,
  InMemoryMcpRegistryRepository,
  InMemoryPreviewArtifactStore,
  InMemoryRequirementRepository,
  InMemorySkillArtifactStore,
  InMemorySkillRegistryRepository,
  InMemoryWorkerFleetRepository,
  SqliteLifecycleRepository,
  SqliteLifecycleArtifactStore,
} from "@forgex/application";
import { EvidenceAuthority } from "@forgex/domain";
import {
  McpHealthAuthority,
  SkillEvaluationAuthority,
} from "@forgex/extensions";
import {
  LifecycleExecutorPrincipalSchema,
  LifecycleRoleSchema,
} from "@forgex/contracts/lifecycle";
import { buildControlPlaneApi } from "../../apps/control-plane-api/dist/index.js";
import { HashedLifecycleExecutorAuthenticator } from "../../apps/control-plane-api/dist/lifecycle-api.js";
import {
  savePrivateBytes,
  savePrivateJson,
} from "../../services/device-worker/dist/lifecycle-transfer.js";
import { assertLifecyclePrivatePath } from "../../services/device-worker/dist/lifecycle-runtime.js";
import { LocalGitCommandRunner } from "../../services/device-worker/dist/workspace.js";

const names = {
  requester: "需求方",
  product_owner: "产品负责人",
  developer: "研发负责人",
  tester: "测试负责人",
  test_ops: "测试运维",
  production_ops: "生产运维",
};
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(["codex", "fixture"]),
    tenantKey: z.string().uuid(),
    projectKey: z.string().uuid(),
    repositoryKey: z.string().uuid(),
    people: z
      .array(
        z
          .object({
            actorKey: z.string().uuid(),
            tenantKey: z.string().uuid(),
            actorName: z.string(),
            username: z.string(),
            roles: z.array(LifecycleRoleSchema),
            token: z.string().uuid(),
          })
          .strict(),
      )
      .length(6),
    executors: z
      .array(
        z
          .object({
            name: z.enum(["agent", "test", "staging", "production"]),
            tokenSha256: z.string().regex(/^[a-f0-9]{64}$/u),
            executor: LifecycleExecutorPrincipalSchema,
          })
          .strict(),
      )
      .length(4),
  })
  .strict();
const here = fileURLToPath(new URL("./", import.meta.url));

export async function initializeDurableSample({
  root,
  origin = "http://127.0.0.1:3000",
  mode = "codex",
}) {
  await mkdir(path.resolve(root), { recursive: true, mode: 0o700 });
  root = await realpath(root);
  await assertLifecyclePrivatePath(root);
  const manifestFile = path.join(root, "controller", "manifest.json");
  try {
    await access(manifestFile);
    const manifest = await readDurableManifest(root);
    if (manifest.mode !== mode)
      throw new Error("已有样板模式不同，请使用另一个隔离目录");
    return { root, manifest };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const tenantKey = randomUUID(),
    projectKey = randomUUID(),
    repositoryKey = randomUUID();
  const people = Object.entries(names).map(([role, label]) => ({
    actorKey: randomUUID(),
    tenantKey,
    actorName: `样板${label}`,
    username: `p0.${role}`,
    roles: [role],
    token: randomUUID(),
  }));
  const definitions = {
    agent: ["requirements_ai", "design_ai", "development"],
    test: ["testing"],
    staging: ["staging_deploy"],
    production: ["production_deploy", "production_rollback"],
  };
  const contract = await readFile(
      path.join(here, "business-contract.md"),
      "utf8",
    ),
    git = new LocalGitCommandRunner(),
    executors = [];
  for (const [name, capabilities] of Object.entries(definitions)) {
    const workerRoot = path.join(root, "workers", name);
    await mkdir(workerRoot, { recursive: true, mode: 0o700 });
    const pair = generateKeyPairSync("ed25519"),
      token = randomUUID(),
      privateKeyPath = path.join(workerRoot, "signing-key.pem");
    await savePrivateBytes(
      privateKeyPath,
      Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })),
    );
    const executor = {
      executorKey: randomUUID(),
      tenantKey,
      projectKey,
      repositoryKey,
      capabilities,
      publicKeyBase64: pair.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64"),
    };
    executors.push({
      name,
      tokenSha256: createHash("sha256").update(token).digest("hex"),
      executor,
    });
    const config = {
      schemaVersion: 2,
      controlPlaneOrigin: origin,
      token,
      privateKeyPath,
      journalRoot: path.join(workerRoot, "journal"),
      pollIntervalMs: 1000,
      sample: {
        schemaVersion: 1,
        root: path.join(workerRoot, "pipeline"),
        sourcePath: path.join(here, "app.mjs"),
        ...(mode === "codex"
          ? { businessRuntimePath: path.join(here, "business-runtime.mjs") }
          : {}),
      },
    };
    if (mode === "codex" && ["agent", "test"].includes(name)) {
      const repositoryRoot = path.join(workerRoot, "repository");
      await mkdir(repositoryRoot, { mode: 0o700 });
      await savePrivateBytes(
        path.join(repositoryRoot, "README.md"),
        Buffer.from(contract),
      );
      await savePrivateBytes(
        path.join(repositoryRoot, "appointment.js"),
        Buffer.from(
          'function handleAppointment(input) { throw new Error("业务尚未实现"); }\n',
        ),
      );
      await git.run(["init", "-q", "-b", "main", repositoryRoot]);
      await git.run([
        "-C",
        repositoryRoot,
        "add",
        "README.md",
        "appointment.js",
      ]);
      await git.run([
        "-C",
        repositoryRoot,
        "-c",
        "user.name=ForgeX 隔离样板",
        "-c",
        "user.email=sample@forgex.local",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "-qm",
        "初始化：独立执行器业务协议",
      ]);
      config.execution = {
        schemaVersion: 1,
        provider: "codex",
        mode: "current_user",
        project: {
          projectKey,
          repositoryKey,
          repositoryRoot,
          worktreeRoot: path.join(workerRoot, "worktrees"),
          baseRef: "main",
          reasoningEffort: "low",
          ...(process.env.FORGEX_CODEX_MODEL
            ? { model: process.env.FORGEX_CODEX_MODEL }
            : {}),
        },
        codexHomePath:
          process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
        protectedPaths: [repositoryRoot],
        instructions: `当前是隔离样板协议，必须遵守以下能力和验收范围：\n${contract}`,
        testingAgent: true,
        allowedDevelopmentFiles: ["appointment.js"],
      };
    }
    await savePrivateJson(path.join(workerRoot, "config.json"), config);
  }
  const manifest = manifestSchema.parse({
    schemaVersion: 1,
    mode,
    tenantKey,
    projectKey,
    repositoryKey,
    people,
    executors,
  });
  await savePrivateJson(manifestFile, manifest);
  return { root, manifest };
}
export async function readDurableManifest(root) {
  const file = path.join(root, "controller", "manifest.json");
  await assertLifecyclePrivatePath(file);
  return manifestSchema.parse(JSON.parse(await readFile(file, "utf8")));
}
export async function setDurableOrigin(root, origin) {
  for (const name of ["agent", "test", "staging", "production"]) {
    const file = path.join(root, "workers", name, "config.json");
    await assertLifecyclePrivatePath(file);
    const config = JSON.parse(await readFile(file, "utf8"));
    config.controlPlaneOrigin = origin;
    await savePrivateJson(file, config);
  }
}
export async function buildDurableControlPlane(root) {
  const manifest = await readDurableManifest(root),
    repository = await SqliteLifecycleRepository.open(
      path.join(root, "controller", "lifecycle.sqlite"),
    ),
    artifactStore = await SqliteLifecycleArtifactStore.open(
      path.join(root, "controller", "artifacts.sqlite"),
    );
  const accountService = new AccountAdministrationService(
    new InMemoryAccountRepository(
      manifest.people.map((p) => ({
        accountKey: p.actorKey,
        tenantKey: p.tenantKey,
        username: p.username,
        actorName: p.actorName,
        roles: p.roles,
        password: "P0-Sample-2026!",
        enabled: true,
        revision: 1,
      })),
    ),
  );
  const app = buildControlPlaneApi({
    accountService,
    lifecycleRepository: repository,
    lifecycleArtifactStore: artifactStore,
    lifecycleExecutorAuthenticator: new HashedLifecycleExecutorAuthenticator(
      manifest.executors,
    ),
    authenticator: {
      authenticate: async (authorization) => {
        const p = manifest.people.find(
          (p) => authorization === `Bearer ${p.token}`,
        );
        if (!p) return null;
        const { token, ...principal } = p;
        return principal;
      },
    },
    runnerAuthenticator: { authenticate: async () => null },
    evidenceAuthority: new EvidenceAuthority({ runners: [] }),
    extensionCatalogRepository: new InMemoryExtensionCatalogRepository(),
    knowledgeBaseRepository: new InMemoryKnowledgeBaseRepository(),
    mcpHealthAuthority: new McpHealthAuthority({ verifiers: [] }),
    mcpInputSchemaStore: new InMemoryMcpInputSchemaStore(),
    mcpInvocationRepository: new InMemoryMcpInvocationRepository(),
    mcpRegistryRepository: new InMemoryMcpRegistryRepository(),
    previewArtifactStore: new InMemoryPreviewArtifactStore(),
    projectKey: manifest.projectKey,
    repositoryKey: manifest.repositoryKey,
    requirementRepository: new InMemoryRequirementRepository(),
    skillArtifactStore: new InMemorySkillArtifactStore(),
    skillEvaluationAuthority: new SkillEvaluationAuthority({ evaluators: [] }),
    skillRegistryRepository: new InMemorySkillRegistryRepository(),
    workerFleetRepository: new InMemoryWorkerFleetRepository(),
    sessionCookieSecure: false,
  });
  app.addHook("onClose", async () => {
    repository.close();
    artifactStore.close();
  });
  return { app, manifest };
}
