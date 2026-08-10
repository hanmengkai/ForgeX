import {
  McpEnableRecordSchema,
  McpServerRegistrySnapshotSchema,
  type McpEnableRecord,
  type McpServerRegistrySnapshot,
} from "@forgex/extensions";

export interface McpEnableAuditEvent extends McpEnableRecord {
  eventKey: string;
  tenantKey: string;
  projectKey: string;
}

export interface McpRegistryTransaction {
  load(): McpServerRegistrySnapshot | null;
  save(snapshot: McpServerRegistrySnapshot): void;
  appendAudit(event: McpEnableAuditEvent): void;
}

export interface McpRegistryRepository {
  transaction<T>(
    tenantKey: string,
    projectKey: string,
    operation: (transaction: McpRegistryTransaction) => Promise<T> | T,
  ): Promise<T>;
  listAudit(
    tenantKey: string,
    projectKey: string,
    limit?: number,
  ): Promise<McpEnableAuditEvent[]>;
}

const internalKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const normalizeKey = (value: string, label: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!internalKeyPattern.test(normalized)) {
    throw new Error(`${label}格式不正确`);
  }
  return normalized;
};
const scopeKey = (tenantKey: string, projectKey: string): string =>
  `${normalizeKey(tenantKey, "租户标识")}:${normalizeKey(projectKey, "项目标识")}`;

export class InMemoryMcpRegistryRepository implements McpRegistryRepository {
  readonly #snapshots = new Map<string, McpServerRegistrySnapshot>();
  readonly #auditByScope = new Map<string, McpEnableAuditEvent[]>();
  readonly #scopeTails = new Map<string, Promise<void>>();

  async transaction<T>(
    tenantKey: string,
    projectKey: string,
    operation: (transaction: McpRegistryTransaction) => Promise<T> | T,
  ): Promise<T> {
    const key = scopeKey(tenantKey, projectKey);
    const previous = this.#scopeTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#scopeTails.set(key, current);
    await previous;

    let pendingSnapshot = this.#snapshots.get(key)
      ? structuredClone(this.#snapshots.get(key)!)
      : null;
    const pendingAudit = structuredClone(this.#auditByScope.get(key) ?? []);
    let snapshotChanged = false;
    let auditChanged = false;
    const transaction: McpRegistryTransaction = {
      load: () => (pendingSnapshot ? structuredClone(pendingSnapshot) : null),
      save: (input) => {
        const snapshot = McpServerRegistrySnapshotSchema.parse(input);
        if (scopeKey(snapshot.tenantKey, snapshot.projectKey) !== key) {
          throw new Error("MCP 仓储事务不能写入其他租户或项目");
        }
        pendingSnapshot = structuredClone(snapshot);
        snapshotChanged = true;
      },
      appendAudit: (input) => {
        if (scopeKey(input.tenantKey, input.projectKey) !== key) {
          throw new Error("MCP 仓储事务不能写入其他范围的审计");
        }
        const eventKey = normalizeKey(input.eventKey, "审计标识");
        if (pendingAudit.some((event) => event.eventKey === eventKey)) {
          throw new Error("MCP 审计标识不能重复");
        }
        const record = McpEnableRecordSchema.parse({
          action: input.action,
          actorKey: input.actorKey,
          actorName: input.actorName,
          serverKey: input.serverKey,
          revision: input.revision,
          attestationKey: input.attestationKey,
          recordedAt: input.recordedAt,
        });
        pendingAudit.push({
          eventKey,
          tenantKey: normalizeKey(input.tenantKey, "租户标识"),
          projectKey: normalizeKey(input.projectKey, "项目标识"),
          ...record,
        });
        auditChanged = true;
      },
    };

    try {
      const result = await operation(transaction);
      if (snapshotChanged && pendingSnapshot) {
        this.#snapshots.set(key, structuredClone(pendingSnapshot));
      }
      if (auditChanged) {
        this.#auditByScope.set(key, structuredClone(pendingAudit));
      }
      return result;
    } finally {
      release();
      if (this.#scopeTails.get(key) === current) this.#scopeTails.delete(key);
    }
  }

  async listAudit(
    tenantKey: string,
    projectKey: string,
    limit = 100,
  ): Promise<McpEnableAuditEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("MCP 审计查询条数必须在 1 到 100 之间");
    }
    const key = scopeKey(tenantKey, projectKey);
    await this.#scopeTails.get(key);
    return structuredClone(
      (this.#auditByScope.get(key) ?? []).slice(-limit).reverse(),
    );
  }
}
