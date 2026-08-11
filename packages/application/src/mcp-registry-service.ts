import { randomUUID } from "node:crypto";

import {
  McpServerManifestSchema,
  McpServerRegistry,
  SignedMcpHealthAttestationSchema,
  type McpHealthAuthority,
  type McpProbeBinding,
  type McpServerManifest,
  type McpServerPeopleView,
  type McpServerRegistryItemForPeople,
  type McpServerRegistrySnapshot,
  type McpToolDefinition,
  type SignedMcpHealthAttestation,
} from "@forgex/extensions";

import type { AuthenticatedPrincipal } from "./auth.js";
import { containsLikelyPlaintextCredential } from "./credential-safety.js";
import { ApplicationError } from "./errors.js";
import type {
  McpEnableAuditEvent,
  McpRegistryRepository,
  McpRegistryTransaction,
} from "./mcp-registry-repository.js";

export interface McpRegistryApplicationServiceOptions {
  repository: McpRegistryRepository;
  projectKey: string;
  healthAuthority: McpHealthAuthority;
  clock?: () => Date;
}

const internalKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const manifestTextValues = (manifest: McpServerManifest): string[] => [
  manifest.name,
  manifest.summary,
  ...manifest.tools.flatMap((tool) => [
    tool.technicalName,
    tool.displayName,
    tool.description,
  ]),
];

export const assertMcpManifestContainsNoCredential = (
  manifest: McpServerManifest,
): void => {
  if (manifestTextValues(manifest).some(containsLikelyPlaintextCredential)) {
    throw new ApplicationError(
      422,
      "mcp_credential_detected",
      "MCP 清单不能包含明文凭据，认证只能使用客户设备上的本地连接绑定",
    );
  }
};

export class McpRegistryApplicationService {
  readonly #repository: McpRegistryRepository;
  readonly #projectKey: string;
  readonly #healthAuthority: McpHealthAuthority;
  readonly #clock: () => Date;

  constructor(options: McpRegistryApplicationServiceOptions) {
    if (!internalKeyPattern.test(options.projectKey)) {
      throw new Error("项目范围必须使用有效的内部标识");
    }
    this.#repository = options.repository;
    this.#projectKey = options.projectKey.toLowerCase();
    this.#healthAuthority = options.healthAuthority;
    this.#clock = options.clock ?? (() => new Date());
  }

  async publish(
    principal: AuthenticatedPrincipal,
    manifest: McpServerManifest,
  ): Promise<void> {
    this.#assertAdministrator(principal);
    const parsed = McpServerManifestSchema.parse(manifest);
    assertMcpManifestContainsNoCredential(parsed);
    if (
      parsed.tenantKey !== principal.tenantKey ||
      parsed.projectKey !== this.#projectKey
    ) {
      throw new ApplicationError(
        422,
        "mcp_scope_mismatch",
        "MCP 服务器不属于当前租户或项目",
      );
    }
    await this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      (transaction) => {
        const registry = this.#restore(principal.tenantKey, transaction.load());
        registry.publish(parsed);
        transaction.save(registry.snapshot());
      },
    );
  }

  async recordHealth(
    tenantKey: string,
    input: SignedMcpHealthAttestation,
  ): Promise<{
    recoveryChallengeKey: string | null;
    nextProbeSequence: number;
    previousAttestationKey: string | null;
  }> {
    const signed = SignedMcpHealthAttestationSchema.parse(input);
    const normalizedTenant = tenantKey.toLowerCase();
    if (
      signed.payload.tenantKey !== normalizedTenant ||
      signed.payload.projectKey !== this.#projectKey
    ) {
      throw new Error("MCP 探测不属于当前租户或项目");
    }
    return this.#repository.transaction(
      normalizedTenant,
      this.#projectKey,
      (transaction) => {
        const registry = this.#restore(normalizedTenant, transaction.load());
        const outcome = registry.recordHealth(signed);
        if (outcome.transition) {
          transaction.appendAudit({
            ...outcome.transition,
            eventKey: randomUUID(),
            tenantKey: normalizedTenant,
            projectKey: this.#projectKey,
          });
        }
        transaction.save(registry.snapshot());
        return {
          recoveryChallengeKey: outcome.recoveryChallengeKey,
          nextProbeSequence: outcome.nextProbeSequence,
          previousAttestationKey: outcome.previousAttestationKey,
        };
      },
    );
  }

  async hasRecordedHealth(
    tenantKey: string,
    input: SignedMcpHealthAttestation,
  ): Promise<boolean> {
    const signed = SignedMcpHealthAttestationSchema.parse(input);
    const normalizedTenant = tenantKey.toLowerCase();
    if (
      signed.payload.tenantKey !== normalizedTenant ||
      signed.payload.projectKey !== this.#projectKey
    ) {
      throw new Error("MCP 探测不属于当前租户或项目");
    }
    return this.#repository.transaction(
      normalizedTenant,
      this.#projectKey,
      (transaction) =>
        this.#restore(normalizedTenant, transaction.load()).hasRecordedHealth(
          signed,
        ),
    );
  }

  async enable(
    principal: AuthenticatedPrincipal,
    serverKey: string,
    revision: number,
  ): Promise<void> {
    this.#assertAdministrator(principal);
    await this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      (transaction) => {
        const registry = this.#restore(principal.tenantKey, transaction.load());
        const record = registry.enable({
          serverKey,
          revision,
          actor: {
            actorKey: principal.actorKey,
            actorName: principal.actorName,
          },
        });
        if (!record) return;
        const audit: McpEnableAuditEvent = {
          ...record,
          eventKey: randomUUID(),
          tenantKey: principal.tenantKey,
          projectKey: this.#projectKey,
        };
        transaction.appendAudit(audit);
        transaction.save(registry.snapshot());
      },
    );
  }

  async recover(
    principal: AuthenticatedPrincipal,
    serverKey: string,
    revision: number,
    attestationKey: string,
  ): Promise<void> {
    this.#assertAdministrator(principal);
    await this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      (transaction) => {
        const registry = this.#restore(principal.tenantKey, transaction.load());
        const record = registry.recover({
          serverKey,
          revision,
          attestationKey,
          actor: {
            actorKey: principal.actorKey,
            actorName: principal.actorName,
          },
        });
        if (!record) return;
        transaction.appendAudit({
          ...record,
          eventKey: randomUUID(),
          tenantKey: principal.tenantKey,
          projectKey: this.#projectKey,
        });
        transaction.save(registry.snapshot());
      },
    );
  }

  async disable(
    principal: AuthenticatedPrincipal,
    serverKey: string,
  ): Promise<void> {
    this.#assertAdministrator(principal);
    await this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      (transaction) => {
        const registry = this.#restore(principal.tenantKey, transaction.load());
        const record = registry.disable({
          serverKey,
          actor: {
            actorKey: principal.actorKey,
            actorName: principal.actorName,
          },
        });
        if (!record) return;
        transaction.appendAudit({
          ...record,
          eventKey: randomUUID(),
          tenantKey: principal.tenantKey,
          projectKey: this.#projectKey,
        });
        transaction.save(registry.snapshot());
      },
    );
  }

  async listForPeople(
    principal: AuthenticatedPrincipal,
  ): Promise<McpServerPeopleView[]> {
    return this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      (transaction) =>
        this.#restore(principal.tenantKey, transaction.load()).listForPeople(),
    );
  }

  async listItemsForPeople(
    principal: AuthenticatedPrincipal,
  ): Promise<McpServerRegistryItemForPeople[]> {
    return this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      (transaction) =>
        this.#restore(
          principal.tenantKey,
          transaction.load(),
        ).listItemsForPeople(),
    );
  }

  async getEnabledToolForInvocation(
    tenantKey: string,
    serverKey: string,
    toolKey: string,
    projectKey = this.#projectKey,
  ): Promise<{
    manifest: McpServerManifest;
    tool: McpToolDefinition;
    serverIdentityHash: string;
  } | null> {
    if (!internalKeyPattern.test(projectKey)) {
      throw new Error("项目范围必须使用有效的内部标识");
    }
    const normalizedProjectKey = projectKey.toLowerCase();
    return this.#repository.transaction(
      tenantKey,
      normalizedProjectKey,
      (transaction) =>
        this.#restore(
          tenantKey,
          transaction.load(),
          normalizedProjectKey,
        ).getEnabledTool(serverKey, toolKey),
    );
  }

  async getEnabledManifestForInvocation(
    tenantKey: string,
    serverKey: string,
    projectKey = this.#projectKey,
  ): Promise<McpServerManifest | null> {
    if (!internalKeyPattern.test(projectKey)) {
      throw new Error("项目范围必须使用有效的内部标识");
    }
    const normalizedProjectKey = projectKey.toLowerCase();
    return this.#repository.transaction(
      tenantKey,
      normalizedProjectKey,
      (transaction) =>
        this.#restore(
          tenantKey,
          transaction.load(),
          normalizedProjectKey,
        ).getEnabledManifest(serverKey),
    );
  }

  async getRecoveryChallenge(
    tenantKey: string,
    serverKey: string,
    revision: number,
  ): Promise<string | null> {
    return this.#repository.transaction(
      tenantKey,
      this.#projectKey,
      (transaction) =>
        this.#restore(tenantKey, transaction.load()).getRecoveryChallenge(
          serverKey,
          revision,
        ),
    );
  }

  async getNextProbeBinding(
    tenantKey: string,
    serverKey: string,
    revision: number,
  ): Promise<McpProbeBinding> {
    return this.#repository.transaction(
      tenantKey,
      this.#projectKey,
      (transaction) =>
        this.#restore(tenantKey, transaction.load()).getNextProbeBinding(
          serverKey,
          revision,
        ),
    );
  }

  #restore(
    tenantKey: string,
    snapshot: McpServerRegistrySnapshot | null,
    projectKey = this.#projectKey,
  ): McpServerRegistry {
    const options = {
      tenantKey,
      projectKey,
      healthAuthority: this.#healthAuthority,
      clock: this.#clock,
    };
    return snapshot
      ? McpServerRegistry.fromSnapshot(snapshot, options)
      : new McpServerRegistry(options);
  }

  #assertAdministrator(principal: AuthenticatedPrincipal): void {
    if (!principal.roles.includes("administrator")) {
      throw new ApplicationError(
        403,
        "mcp_admin_required",
        "只有平台管理员可以发布或启用 MCP 外部工具",
      );
    }
  }
}
