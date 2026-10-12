import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
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
  InMemoryLifecycleRepository,
  type LifecycleRepository,
  type PlatformRole,
  type LifecycleArtifactStore,
} from "@forgex/application";
import { EvidenceAuthority } from "@forgex/domain";
import {
  McpHealthAuthority,
  SkillEvaluationAuthority,
} from "@forgex/extensions";
import type {
  LifecycleCapability,
  LifecycleRole,
  LifecycleView,
} from "@forgex/contracts/lifecycle";
import {
  HttpLifecycleClient,
  LifecycleExecutorRuntime,
  MemoryLifecycleJournal,
} from "../../../services/device-worker/src/lifecycle-runtime.js";
import { SampleLifecycleAdapter } from "../../../services/device-worker/src/lifecycle-sample-adapter.js";
import { buildControlPlaneApi } from "../src/index.js";
import { HashedLifecycleExecutorAuthenticator } from "../src/lifecycle-api.js";

export const createLifecycleFixture = async (
  repository: LifecycleRepository = new InMemoryLifecycleRepository(),
  options: {
    realAI?: boolean;
    onAgentResult?: (record: unknown) => Promise<void>;
    artifactStore?: LifecycleArtifactStore;
  } = {},
) => {
  const tenantKey = randomUUID(),
    projectKey = randomUUID(),
    repositoryKey = randomUUID();
  const people = Object.fromEntries(
    (
      [
        "requester",
        "product_owner",
        "developer",
        "tester",
        "test_ops",
        "production_ops",
      ] as const
    ).map((role) => [
      role,
      {
        actorKey: randomUUID(),
        tenantKey,
        actorName: `样板${role}`,
        username: `p0.${role}`,
        roles: [role] as PlatformRole[],
        token: randomUUID(),
      },
    ]),
  ) as Record<
    | "requester"
    | "product_owner"
    | "developer"
    | "tester"
    | "test_ops"
    | "production_ops",
    {
      actorKey: string;
      tenantKey: string;
      actorName: string;
      username: string;
      roles: PlatformRole[];
      token: string;
    }
  >;
  const accountService = new AccountAdministrationService(
    new InMemoryAccountRepository(
      Object.values(people).map((person) => ({
        accountKey: person.actorKey,
        tenantKey,
        username: person.username,
        actorName: person.actorName,
        roles: person.roles,
        password: "P0-Sample-2026!",
        enabled: true,
        revision: 1,
      })),
    ),
  );
  const definitions = [
    {
      name: "agent",
      capabilities: ["requirements_ai", "design_ai", "development"],
    },
    { name: "test", capabilities: ["testing"] },
    { name: "staging", capabilities: ["staging_deploy"] },
    {
      name: "production",
      capabilities: ["production_deploy", "production_rollback"],
    },
  ] as const;
  const executors = definitions.map((definition) => {
    const pair = generateKeyPairSync("ed25519"),
      token = randomUUID();
    return {
      name: definition.name,
      token,
      privateKey: pair.privateKey,
      executor: {
        executorKey: randomUUID(),
        tenantKey,
        projectKey,
        repositoryKey,
        capabilities: [...definition.capabilities] as LifecycleCapability[],
        publicKeyBase64: pair.publicKey
          .export({ type: "spki", format: "der" })
          .toString("base64"),
      },
    };
  });
  const app = buildControlPlaneApi({
    accountService,
    authenticator: {
      authenticate: async (authorization) => {
        const person = Object.values(people).find(
          (p) => authorization === `Bearer ${p.token}`,
        );
        return person
          ? {
              actorKey: person.actorKey,
              tenantKey,
              actorName: person.actorName,
              username: person.username,
              roles: person.roles,
            }
          : null;
      },
    },
    lifecycleRepository: repository,
    ...(options.artifactStore
      ? { lifecycleArtifactStore: options.artifactStore }
      : {}),
    lifecycleExecutorAuthenticator: new HashedLifecycleExecutorAuthenticator(
      executors.map((e) => ({
        tokenSha256: createHash("sha256").update(e.token).digest("hex"),
        executor: e.executor,
      })),
    ),
    runnerAuthenticator: { authenticate: async () => null },
    evidenceAuthority: new EvidenceAuthority({ runners: [] }),
    extensionCatalogRepository: new InMemoryExtensionCatalogRepository(),
    knowledgeBaseRepository: new InMemoryKnowledgeBaseRepository(),
    mcpHealthAuthority: new McpHealthAuthority({ verifiers: [] }),
    mcpInputSchemaStore: new InMemoryMcpInputSchemaStore(),
    mcpInvocationRepository: new InMemoryMcpInvocationRepository(),
    mcpRegistryRepository: new InMemoryMcpRegistryRepository(),
    previewArtifactStore: new InMemoryPreviewArtifactStore(),
    projectKey,
    repositoryKey,
    requirementRepository: new InMemoryRequirementRepository(),
    skillArtifactStore: new InMemorySkillArtifactStore(),
    skillEvaluationAuthority: new SkillEvaluationAuthority({ evaluators: [] }),
    skillRegistryRepository: new InMemorySkillRegistryRepository(),
    workerFleetRepository: new InMemoryWorkerFleetRepository(),
    sessionCookieSecure: false,
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const root = await mkdtemp(path.join(os.tmpdir(), "forgex-p0-"));
  const ai = options.realAI
    ? await (
        await import(
          new URL("../../../examples/p0-sample/ai-adapter.mjs", import.meta.url)
            .href
        )
      ).createAiSampleAdapter({
        root,
        projectKey,
        repositoryKey,
        onAgentResult: options.onAgentResult,
      })
    : null;
  const adapter: SampleLifecycleAdapter =
    ai?.pipeline ??
    new SampleLifecycleAdapter({
      root,
      sourcePath: fileURLToPath(
        new URL("../../../examples/p0-sample/app.mjs", import.meta.url),
      ),
    });
  const runtimes = Object.fromEntries(
    executors.map((e) => [
      e.name,
      new LifecycleExecutorRuntime({
        client: new HttpLifecycleClient({ origin, token: e.token }),
        adapter: ai?.adapter ?? adapter,
        journal: new MemoryLifecycleJournal(),
        privateKey: e.privateKey,
        ...(options.realAI
          ? {
              onExecutionError: (message: string) =>
                console.error(`本地真实 Agent 诊断：${message}`),
            }
          : {}),
      }),
    ]),
  );
  const request = async (
    role: keyof typeof people,
    method: "GET" | "POST",
    url: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${people[role].token}` },
      ...(payload
        ? {
            payload: JSON.stringify(payload),
            headers: {
              authorization: `Bearer ${people[role].token}`,
              "content-type": "application/json",
            },
          }
        : {}),
    });
  const get = async (
    key: string,
    role: keyof typeof people = "developer",
  ): Promise<LifecycleView> => {
    const response = await request(role, "GET", `/api/v2/lifecycle/${key}`);
    if (response.statusCode !== 200) throw new Error(response.body);
    return response.json().data as LifecycleView;
  };
  const approve = async (key: string, role: LifecycleRole) => {
    const current = await get(key, role as keyof typeof people);
    const response = await request(
      role as keyof typeof people,
      "POST",
      `/api/v2/lifecycle/${key}/decisions`,
      {
        schemaVersion: 2,
        requestKey: randomUUID(),
        expectedVersion: current.version,
        role,
        decision: "approve",
        reason: "样板测试中的人工确认输入：已核对本轮结果",
      },
    );
    if (response.statusCode !== 200) throw new Error(response.body);
    return response.json().data as LifecycleView;
  };
  const runTo = async (key: string, target: string) => {
    for (let step = 0; step < 50; step++) {
      const flow = await get(key);
      if (flow.stage === target) return flow;
      if (flow.blockedReason) throw new Error(flow.blockedReason);
      const capability = flow.stage;
      const executor = executors.find((e) =>
        e.executor.capabilities.includes(capability as LifecycleCapability),
      );
      if (executor) {
        if (!(await runtimes[executor.name]!.tick()))
          throw new Error("自动阶段未能领取");
      } else {
        const needed = flow.allowedRoles[0];
        if (needed) await approve(key, needed);
        else {
          const approvals: Record<string, LifecycleRole[]> = {
            requirements_review: ["product_owner"],
            requester_confirmation: ["requester"],
            design_review: ["developer"],
            code_review: ["developer"],
            test_review: ["tester"],
            staging_acceptance: ["requester"],
            release_approval: ["developer", "production_ops", "requester"],
            online_acceptance: ["developer", "production_ops", "requester"],
            recovery_approval: ["developer", "production_ops", "requester"],
          };
          const remaining = approvals[flow.stage]?.find(
            (r) => !flow.approvals.some((a) => a.role === r),
          );
          if (!remaining) throw new Error(`未识别阶段 ${flow.stage}`);
          await approve(key, remaining);
        }
      }
    }
    throw new Error("样板流程超过阶段限制");
  };
  const create = async () => {
    const response = await request("requester", "POST", "/api/v2/lifecycle", {
      schemaVersion: 2,
      requestKey: randomUUID(),
      projectKey,
      repositoryKey,
      requesterKey: people.requester.actorKey,
      title: "访客预约",
      brief: "访客提交预约并获得可查询编号，重复请求保持幂等",
    });
    if (response.statusCode !== 201) throw new Error(response.body);
    return response.json().data as LifecycleView;
  };
  return {
    app,
    people,
    executors,
    runtimes,
    adapter,
    aiRecords: ai?.records ?? [],
    repository,
    root,
    origin,
    tenantKey,
    projectKey,
    repositoryKey,
    request,
    get,
    approve,
    runTo,
    create,
    close: async () => {
      await adapter.close();
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
};
