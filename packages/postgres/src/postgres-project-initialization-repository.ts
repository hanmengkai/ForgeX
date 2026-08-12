import {
  ApplicationError,
  type ProjectInitializationRecord,
  type ProjectInitializationRepository,
} from "@forgex/application";
import { z } from "zod";

import type { PostgresQueryResult } from "./postgres-worker-fleet-repository.js";

export interface PostgresProjectInitializationPool {
  query(text: string, values?: unknown[]): Promise<PostgresQueryResult>;
}

const rowSchema = z
  .object({
    tenant_key: z.string().uuid(),
    project_key: z.string().uuid(),
    preset_key: z.string().trim().min(1).max(100),
    preset_version: z.coerce.number().int().positive(),
    request_key: z.string().uuid(),
    created_by_key: z.string().uuid(),
    created_by_name: z.string().trim().min(2).max(100),
    created_at: z.unknown(),
  })
  .passthrough();

const isoDate = (value: unknown): string => {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("项目初始化时间无效");
  }
  return date.toISOString();
};

const recordFrom = (row: unknown): ProjectInitializationRecord => {
  const parsed = rowSchema.parse(row);
  return {
    schemaVersion: 1,
    tenantKey: parsed.tenant_key.toLowerCase(),
    projectKey: parsed.project_key.toLowerCase(),
    presetKey: parsed.preset_key,
    presetVersion: parsed.preset_version,
    requestKey: parsed.request_key.toLowerCase(),
    createdByKey: parsed.created_by_key.toLowerCase(),
    createdByName: parsed.created_by_name,
    createdAt: isoDate(parsed.created_at),
  };
};

const selectColumns =
  "tenant_key, project_key, preset_key, preset_version, request_key, created_by_key, created_by_name, created_at";

export class PostgresProjectInitializationRepository implements ProjectInitializationRepository {
  constructor(readonly pool: PostgresProjectInitializationPool) {}

  async find(
    tenantKey: string,
    projectKey: string,
  ): Promise<ProjectInitializationRecord | null> {
    const result = await this.pool.query(
      `SELECT ${selectColumns} FROM forgex_project_initializations WHERE tenant_key = $1 AND project_key = $2 LIMIT 1`,
      [tenantKey.toLowerCase(), projectKey.toLowerCase()],
    );
    return result.rows[0] ? recordFrom(result.rows[0]) : null;
  }

  async createIfAbsent(
    record: ProjectInitializationRecord,
  ): Promise<ProjectInitializationRecord> {
    const result = await this.pool.query(
      `INSERT INTO forgex_project_initializations (tenant_key, project_key, preset_key, preset_version, request_key, created_by_key, created_by_name, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) ON CONFLICT DO NOTHING RETURNING ${selectColumns}`,
      [
        record.tenantKey.toLowerCase(),
        record.projectKey.toLowerCase(),
        record.presetKey,
        record.presetVersion,
        record.requestKey.toLowerCase(),
        record.createdByKey.toLowerCase(),
        record.createdByName,
        record.createdAt,
      ],
    );
    if (result.rows[0]) return recordFrom(result.rows[0]);
    const existing = await this.find(record.tenantKey, record.projectKey);
    if (!existing) {
      throw new ApplicationError(
        409,
        "project_initialization_request_conflict",
        "这个初始化请求已经用于另一个项目，请刷新后重试",
      );
    }
    return existing;
  }
}
