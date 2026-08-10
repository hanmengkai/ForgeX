import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  PostgresPreviewArtifactStore,
  type PostgresClient,
  type PostgresPool,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const requirementKey = "33333333-3333-4333-8333-333333333333";
const content = new TextEncoder().encode("<!doctype html><h1>共享预览</h1>");
const reference = {
  tenantKey,
  projectKey,
  requirementKey,
  requirementRevision: 1,
  artifactHashAlgorithm: "sha256" as const,
  artifactHash: createHash("sha256").update(content).digest("hex"),
};

interface RecordedQuery {
  text: string;
  values?: readonly unknown[];
}

const fakePool = (
  responses: unknown[][],
): {
  pool: PostgresPool;
  queries: RecordedQuery[];
} => {
  const queries: RecordedQuery[] = [];
  const client: PostgresClient = {
    query: async (text, values) => {
      queries.push(values ? { text, values } : { text });
      return { rows: responses.shift() ?? [] };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client }, queries };
};

describe("PostgresPreviewArtifactStore", () => {
  it("使用复合范围键持久化原始字节", async () => {
    const database = fakePool([
      [],
      [{ artifact_hash: reference.artifactHash }],
      [],
    ]);
    const store = new PostgresPreviewArtifactStore(database.pool);

    await store.put({ ...reference, content });

    expect(database.queries.map((query) => query.text)).toEqual([
      "BEGIN",
      expect.stringContaining("INSERT INTO forgex_preview_artifacts"),
      "COMMIT",
    ]);
    expect(database.queries[1]?.values).toEqual([
      tenantKey,
      projectKey,
      requirementKey,
      1,
      reference.artifactHash,
      Buffer.from(content),
    ]);
  });

  it("读取时重新计算摘要并拒绝数据库中的损坏字节", async () => {
    const database = fakePool([[{ content: Buffer.from("被篡改") }]]);
    const store = new PostgresPreviewArtifactStore(database.pool);

    await expect(store.get(reference)).rejects.toThrow(
      "Preview 制品完整性校验失败",
    );
  });

  it("迁移把租户、项目、需求、版本和摘要共同设为不可变主键", () => {
    const migration = readFileSync(
      new URL("../migrations/0004_preview_artifacts.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("CREATE TABLE forgex_preview_artifacts");
    expect(migration).toContain(
      "PRIMARY KEY (tenant_key, project_key, requirement_key, requirement_revision, artifact_hash)",
    );
    expect(migration).toContain("octet_length(content) <= 5242880");
  });

  it("生产接入文档按顺序列出全部迁移和共享 Preview 仓储", () => {
    const readme = readFileSync(
      new URL("../../../README.md", import.meta.url),
      "utf8",
    );
    const migrations = [
      "0001_worker_fleet.sql",
      "0002_requirement_control_plane.sql",
      "0003_requirement_acceptance_audit.sql",
      "0004_preview_artifacts.sql",
      "0005_extension_catalog.sql",
      "0006_skill_registry.sql",
      "0007_mcp_registry.sql",
      "0008_mcp_invocations.sql",
      "0009_worker_work_kinds.sql",
      "0010_knowledge_bases.sql",
      "0011_delivery_runs.sql",
      "0012_runner_verification.sql",
      "0013_verification_failures.sql",
      "0014_browser_sessions.sql",
      "0015_worker_enrollments.sql",
    ];

    const sequenceStart = readme.indexOf("当前完整顺序为");
    const positions = migrations.map((name) =>
      readme.indexOf(name, sequenceStart),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(
      [...positions].sort((left, right) => left - right),
    );
    expect(readme).toContain("PostgresPreviewArtifactStore");
  });
});
