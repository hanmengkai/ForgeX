import type { ExtensionCatalogRepository } from "@forgex/application";
import {
  ExtensionCatalog,
  ExtensionCatalogEntrySchema,
  type ExtensionCatalogEntry,
} from "@forgex/extensions";

import type { PostgresPool } from "./postgres-worker-fleet-repository.js";

const internalKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const normalizeKey = (value: string, label: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!internalKeyPattern.test(normalized)) {
    throw new Error(`${label}格式不正确`);
  }
  return normalized;
};

const definitionFromRow = (row: unknown): ExtensionCatalogEntry => {
  if (typeof row !== "object" || row === null || !("definition" in row)) {
    throw new Error("数据库中的扩展记录格式无效");
  }
  const value =
    typeof row.definition === "string"
      ? (JSON.parse(row.definition) as unknown)
      : row.definition;
  const parsed = ExtensionCatalogEntrySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("数据库中的扩展定义格式无效");
  }
  return parsed.data;
};

export class PostgresExtensionCatalogRepository implements ExtensionCatalogRepository {
  readonly #pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.#pool = pool;
  }

  async list(
    tenantKey: string,
    projectKey: string,
  ): Promise<ExtensionCatalogEntry[]> {
    const tenant = normalizeKey(tenantKey, "租户标识");
    const project = normalizeKey(projectKey, "项目标识");
    const client = await this.#pool.connect();
    try {
      const result = await client.query(
        "SELECT definition FROM forgex_extension_catalog WHERE tenant_key = $1 AND project_key = $2 ORDER BY kind, lower(definition ->> 'name'), extension_key",
        [tenant, project],
      );
      return result.rows.map((row) => {
        const entry = definitionFromRow(row);
        if (entry.tenantKey !== tenant || entry.projectKey !== project) {
          throw new Error("数据库中的扩展不属于查询范围");
        }
        return entry;
      });
    } finally {
      client.release();
    }
  }

  async publish(input: ExtensionCatalogEntry): Promise<void> {
    const entry = ExtensionCatalogEntrySchema.parse(input);
    const client = await this.#pool.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${entry.tenantKey}:${entry.projectKey}`],
      );
      const existing = await client.query(
        "SELECT definition FROM forgex_extension_catalog WHERE tenant_key = $1 AND project_key = $2 ORDER BY kind, extension_key",
        [entry.tenantKey, entry.projectKey],
      );
      const catalog = ExtensionCatalog.restoreLatest(
        {
          tenantKey: entry.tenantKey,
          projectKey: entry.projectKey,
        },
        existing.rows.map(definitionFromRow),
      );
      catalog.publish(entry);
      await client.query(
        "INSERT INTO forgex_extension_catalog (tenant_key, project_key, extension_key, kind, revision, definition) VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (tenant_key, project_key, extension_key) DO UPDATE SET kind = EXCLUDED.kind, revision = EXCLUDED.revision, definition = EXCLUDED.definition, updated_at = now()",
        [
          entry.tenantKey,
          entry.projectKey,
          entry.extensionKey,
          entry.kind,
          entry.revision,
          JSON.stringify(entry),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      if (transactionStarted) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
