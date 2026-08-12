import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { ProjectInitializationRecord } from "@forgex/application";

import {
  PostgresProjectInitializationRepository,
  type PostgresProjectInitializationPool,
  type PostgresQueryResult,
} from "../src/index.js";

const record: ProjectInitializationRecord = {
  schemaVersion: 1,
  tenantKey: "11111111-1111-4111-8111-111111111111",
  projectKey: "22222222-2222-4222-8222-222222222222",
  presetKey: "standard-delivery",
  presetVersion: 1,
  requestKey: "33333333-3333-4333-8333-333333333333",
  createdByKey: "44444444-4444-4444-8444-444444444444",
  createdByName: "平台管理员",
  createdAt: "2026-08-12T10:00:00.000Z",
};

class InitializationPool implements PostgresProjectInitializationPool {
  stored: Record<string, unknown> | null = null;
  insertCount = 0;

  async query(
    text: string,
    values: unknown[] = [],
  ): Promise<PostgresQueryResult> {
    if (text.startsWith("SELECT tenant_key")) {
      const matches = text.includes("request_key = $2")
        ? this.stored?.request_key === values[1]
        : this.stored?.project_key === values[1];
      return {
        rows:
          this.stored && this.stored.tenant_key === values[0] && matches
            ? [this.stored]
            : [],
      };
    }
    if (text.startsWith("INSERT INTO forgex_project_initializations")) {
      this.insertCount += 1;
      if (this.stored) return { rows: [] };
      this.stored = {
        tenant_key: values[0],
        project_key: values[1],
        preset_key: values[2],
        preset_version: values[3],
        request_key: values[4],
        created_by_key: values[5],
        created_by_name: values[6],
        created_at: values[7],
      };
      return { rows: [this.stored] };
    }
    throw new Error(`未预期的 SQL: ${text}`);
  }
}

describe("PostgreSQL 项目初始化仓储", () => {
  it("首次写入后可以按租户和项目读取", async () => {
    const pool = new InitializationPool();
    const repository = new PostgresProjectInitializationRepository(pool);

    await expect(
      repository.find(record.tenantKey, record.projectKey),
    ).resolves.toBeNull();
    await expect(repository.createIfAbsent(record)).resolves.toEqual(record);
    await expect(
      repository.find(record.tenantKey, record.projectKey),
    ).resolves.toEqual(record);
  });

  it("重复初始化保留第一条不可变记录", async () => {
    const pool = new InitializationPool();
    const repository = new PostgresProjectInitializationRepository(pool);
    const first = await repository.createIfAbsent(record);
    const repeated = await repository.createIfAbsent({
      ...record,
      requestKey: "55555555-5555-4555-8555-555555555555",
      createdByName: "另一位管理员",
    });

    expect(first).toEqual(record);
    expect(repeated).toEqual(record);
    expect(pool.insertCount).toBe(2);
  });

  it("同一个请求键不能被另一个项目复用", async () => {
    const pool = new InitializationPool();
    const repository = new PostgresProjectInitializationRepository(pool);
    await repository.createIfAbsent(record);

    await expect(
      repository.createIfAbsent({
        ...record,
        projectKey: "55555555-5555-4555-8555-555555555555",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "project_initialization_request_conflict",
    });
  });

  it("迁移只保存初始化台账，不保存预设 JSON 或连接凭据", async () => {
    const sql = await readFile(
      new URL(
        "../migrations/0021_project_initializations.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(sql).toContain("CREATE TABLE forgex_project_initializations");
    expect(sql).toContain("PRIMARY KEY (tenant_key, project_key)");
    expect(sql).toContain("UNIQUE (tenant_key, request_key)");
    expect(sql).toContain("REFERENCES forgex_platform_projects");
    expect(sql).toMatch(
      /REFERENCES forgex_platform_projects[\s\S]+ON DELETE CASCADE/u,
    );
    expect(sql).not.toMatch(/jsonb|credential|password|token|connection_url/iu);
  });
});
