import { randomUUID } from "node:crypto";

import {
  SignedSkillEvaluationSchema,
  SkillPackageManifestSchema,
  SkillRegistry,
  type SignedSkillEvaluation,
  type SkillEvaluationAuthority,
  type SkillPackageManifest,
  type SkillPeopleView,
  type SkillRegistryItemForPeople,
  type SkillRegistrySnapshot,
} from "@forgex/extensions";

import type { AuthenticatedPrincipal } from "./auth.js";
import { ApplicationError } from "./errors.js";
import type { SkillArtifactStore } from "./skill-artifact-store.js";
import type {
  SkillActivationAuditEvent,
  SkillRegistryRepository,
  SkillRegistryTransaction,
} from "./skill-registry-repository.js";

export interface SkillRegistryApplicationServiceOptions {
  repository: SkillRegistryRepository;
  artifactStore: SkillArtifactStore;
  projectKey: string;
  evaluationAuthority: SkillEvaluationAuthority;
  clock?: () => Date;
}

const internalKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class SkillRegistryApplicationService {
  readonly #repository: SkillRegistryRepository;
  readonly #artifactStore: SkillArtifactStore;
  readonly #projectKey: string;
  readonly #evaluationAuthority: SkillEvaluationAuthority;
  readonly #clock: () => Date;

  constructor(options: SkillRegistryApplicationServiceOptions) {
    if (!internalKeyPattern.test(options.projectKey)) {
      throw new Error("项目范围必须使用有效的内部标识");
    }
    this.#repository = options.repository;
    this.#artifactStore = options.artifactStore;
    this.#projectKey = options.projectKey.toLowerCase();
    this.#evaluationAuthority = options.evaluationAuthority;
    this.#clock = options.clock ?? (() => new Date());
  }

  async publish(
    principal: AuthenticatedPrincipal,
    manifest: SkillPackageManifest,
    artifactBytes: Uint8Array,
  ): Promise<void> {
    this.#assertAdministrator(principal);
    const parsedManifest = SkillPackageManifestSchema.parse(manifest);
    if (
      parsedManifest.tenantKey !== principal.tenantKey ||
      parsedManifest.projectKey !== this.#projectKey
    ) {
      throw new ApplicationError(
        422,
        "skill_scope_mismatch",
        "Skill 包不属于当前租户或项目",
      );
    }
    await this.#artifactStore.put(parsedManifest, artifactBytes);
    await this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      (transaction) => {
        const registry = this.#restore(principal.tenantKey, transaction.load());
        registry.publish(parsedManifest);
        transaction.save(registry.snapshot());
      },
    );
  }

  async recordEvaluation(
    tenantKey: string,
    input: SignedSkillEvaluation,
  ): Promise<void> {
    const signed = SignedSkillEvaluationSchema.parse(input);
    const normalizedTenant = tenantKey.toLowerCase();
    if (
      signed.payload.tenantKey !== normalizedTenant ||
      signed.payload.projectKey !== this.#projectKey
    ) {
      throw new Error("Skill 评测不属于当前租户或项目");
    }
    await this.#repository.transaction(
      normalizedTenant,
      this.#projectKey,
      (transaction) => {
        const registry = this.#restore(normalizedTenant, transaction.load());
        registry.recordEvaluation(signed);
        transaction.save(registry.snapshot());
      },
    );
  }

  async activate(
    principal: AuthenticatedPrincipal,
    skillKey: string,
    version: string,
  ): Promise<void> {
    this.#assertAdministrator(principal);
    const target = await this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      (transaction) =>
        this.#restore(principal.tenantKey, transaction.load()).getVersion(
          skillKey,
          version,
        ),
    );
    if (!target) throw new Error("找不到要激活的 Skill 版本");
    if (!(await this.#artifactStore.get(target))) {
      throw new Error("要激活的 Skill 缺少对应制品");
    }
    await this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      (transaction) => {
        const registry = this.#restore(principal.tenantKey, transaction.load());
        const record = registry.activate({
          skillKey,
          version,
          actor: {
            actorKey: principal.actorKey,
            actorName: principal.actorName,
          },
        });
        if (!record) return;
        const audit: SkillActivationAuditEvent = {
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

  async listForPeople(
    principal: AuthenticatedPrincipal,
  ): Promise<SkillPeopleView[]> {
    return this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      (transaction) =>
        this.#restore(principal.tenantKey, transaction.load()).listForPeople(),
    );
  }

  async listItemsForPeople(
    principal: AuthenticatedPrincipal,
  ): Promise<SkillRegistryItemForPeople[]> {
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

  async getActiveForExecution(
    tenantKey: string,
    skillKey: string,
  ): Promise<{ manifest: SkillPackageManifest; bytes: Uint8Array } | null> {
    const manifest = await this.#repository.transaction(
      tenantKey,
      this.#projectKey,
      (transaction) =>
        this.#restore(tenantKey, transaction.load()).getActive(skillKey),
    );
    if (!manifest) return null;
    const bytes = await this.#artifactStore.get(manifest);
    if (!bytes) throw new Error("已经激活的 Skill 缺少对应制品");
    return { manifest, bytes };
  }

  #restore(
    tenantKey: string,
    snapshot: SkillRegistrySnapshot | null,
  ): SkillRegistry {
    const options = {
      tenantKey,
      projectKey: this.#projectKey,
      evaluationAuthority: this.#evaluationAuthority,
      clock: this.#clock,
    };
    return snapshot
      ? SkillRegistry.fromSnapshot(snapshot, options)
      : new SkillRegistry(options);
  }

  #assertAdministrator(principal: AuthenticatedPrincipal): void {
    if (!principal.roles.includes("administrator")) {
      throw new ApplicationError(
        403,
        "skill_admin_required",
        "只有平台管理员可以发布或切换 Skill",
      );
    }
  }
}
