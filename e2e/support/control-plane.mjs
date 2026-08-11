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
} from "@forgex/application";
import { EvidenceAuthority } from "@forgex/domain";
import {
  McpHealthAuthority,
  SkillEvaluationAuthority,
} from "@forgex/extensions";

import { buildControlPlaneApi } from "../../apps/control-plane-api/dist/index.js";

const token = "e2e-access-token-with-enough-entropy";
const principal = {
  actorKey: "44444444-4444-4444-8444-444444444444",
  actorName: "端到端超级管理员",
  username: "e2e.admin",
  tenantKey: "11111111-1111-4111-8111-111111111111",
  roles: ["product_owner", "requirement_analyst", "administrator"],
};
const accountService = new AccountAdministrationService(
  new InMemoryAccountRepository([
    {
      accountKey: principal.actorKey,
      tenantKey: principal.tenantKey,
      username: principal.username,
      actorName: principal.actorName,
      roles: principal.roles,
      enabled: true,
      revision: 1,
      password: "E2E-Password-2026!",
    },
  ]),
);
const app = buildControlPlaneApi({
  accountService,
  authenticator: {
    authenticate: async (authorization) =>
      authorization === `Bearer ${token}` ? structuredClone(principal) : null,
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
  projectKey: "22222222-2222-4222-8222-222222222222",
  repositoryKey: "33333333-3333-4333-8333-333333333333",
  requirementRepository: new InMemoryRequirementRepository(),
  skillArtifactStore: new InMemorySkillArtifactStore(),
  skillEvaluationAuthority: new SkillEvaluationAuthority({ evaluators: [] }),
  skillRegistryRepository: new InMemorySkillRegistryRepository(),
  workerFleetRepository: new InMemoryWorkerFleetRepository(),
  sessionCookieSecure: false,
});

await app.listen({ host: "127.0.0.1", port: 3000 });

const shutdown = () => {
  void app.close().finally(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
