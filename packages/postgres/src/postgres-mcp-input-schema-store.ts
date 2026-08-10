import {
  canonicalizeMcpInputSchema,
  type McpInputSchemaReference,
  type McpInputSchemaStore,
} from "@forgex/application";

import type { PostgresPool } from "./postgres-worker-fleet-repository.js";

const internalKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;

const normalizeReference = (
  input: McpInputSchemaReference,
): McpInputSchemaReference => {
  const tenantKey = input.tenantKey.trim().toLowerCase();
  const projectKey = input.projectKey.trim().toLowerCase();
  const hash = input.hash.trim().toLowerCase();
  if (
    !internalKeyPattern.test(tenantKey) ||
    !internalKeyPattern.test(projectKey) ||
    input.hashAlgorithm !== "sha256" ||
    !sha256Pattern.test(hash)
  ) {
    throw new Error("MCP 输入 Schema 引用无效");
  }
  return { tenantKey, projectKey, hashAlgorithm: "sha256", hash };
};

const schemaFromRow = (row: unknown): unknown => {
  if (typeof row !== "object" || row === null || !("schema" in row)) {
    throw new Error("数据库中的 MCP 输入 Schema 格式无效");
  }
  return typeof row.schema === "string"
    ? (JSON.parse(row.schema) as unknown)
    : row.schema;
};

export class PostgresMcpInputSchemaStore implements McpInputSchemaStore {
  readonly #pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.#pool = pool;
  }

  async put(
    referenceInput: McpInputSchemaReference,
    schemaInput: unknown,
  ): Promise<void> {
    const reference = normalizeReference(referenceInput);
    const canonical = canonicalizeMcpInputSchema(schemaInput);
    if (canonical.hash !== reference.hash) {
      throw new Error("Schema 内容与登记哈希不一致");
    }
    const client = await this.#pool.connect();
    try {
      const inserted = await client.query(
        'INSERT INTO forgex_mcp_input_schemas (tenant_key, project_key, input_schema_hash, schema, canonical_size_bytes) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT DO NOTHING RETURNING input_schema_hash AS "inputSchemaHash"',
        [
          reference.tenantKey,
          reference.projectKey,
          reference.hash,
          canonical.canonicalJson,
          canonical.sizeBytes,
        ],
      );
      if (inserted.rows.length > 0) return;
      const existing = await client.query(
        "SELECT schema FROM forgex_mcp_input_schemas WHERE tenant_key = $1 AND project_key = $2 AND input_schema_hash = $3",
        [reference.tenantKey, reference.projectKey, reference.hash],
      );
      const stored = canonicalizeMcpInputSchema(
        schemaFromRow(existing.rows[0]),
      );
      if (stored.canonicalJson !== canonical.canonicalJson) {
        throw new Error("内容寻址的 MCP 输入 Schema 不可覆盖");
      }
    } finally {
      client.release();
    }
  }

  async get(
    referenceInput: McpInputSchemaReference,
  ): Promise<Record<string, unknown> | null> {
    const reference = normalizeReference(referenceInput);
    const client = await this.#pool.connect();
    try {
      const result = await client.query(
        "SELECT schema FROM forgex_mcp_input_schemas WHERE tenant_key = $1 AND project_key = $2 AND input_schema_hash = $3",
        [reference.tenantKey, reference.projectKey, reference.hash],
      );
      if (!result.rows[0]) return null;
      const canonical = canonicalizeMcpInputSchema(
        schemaFromRow(result.rows[0]),
      );
      if (canonical.hash !== reference.hash) {
        throw new Error("数据库中的 MCP 输入 Schema 完整性校验失败");
      }
      return canonical.schema;
    } finally {
      client.release();
    }
  }
}
