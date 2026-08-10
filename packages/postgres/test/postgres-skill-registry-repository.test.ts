import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SkillPackageCodec } from "@forgex/extensions";

import {
  PostgresSkillArtifactStore,
  PostgresSkillRegistryRepository,
  type PostgresClient,
  type PostgresPool,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const skillKey = "33333333-3333-4333-8333-333333333333";
const evaluationKey = "44444444-4444-4444-8444-444444444444";
const artifactBytes = SkillPackageCodec.encode({
  schemaVersion: 1,
  instructions: "# 需求风险检查\n\n在开发前检查需求遗漏和歧义。",
  resources: [],
});
const manifest = {
  schemaVersion: 1 as const,
  skillKey,
  tenantKey,
  projectKey,
  version: "1.0.0",
  name: "需求风险检查",
  summary: "在进入开发前检查需求遗漏和歧义",
  artifactHashAlgorithm: "sha256" as const,
  artifactHash: createHash("sha256").update(artifactBytes).digest("hex"),
  artifactSizeBytes: artifactBytes.byteLength,
  entrypoint: "SKILL.md" as const,
  compatibleBlueprints: ["Web 应用"],
  requiredCapabilities: ["读取项目文件"],
  permissions: {
    workspace: "read_only" as const,
    network: "none" as const,
    commands: "none" as const,
  },
  createdAt: "2026-08-10T07:00:00.000Z",
};

const snapshot = {
  schemaVersion: 1 as const,
  tenantKey,
  projectKey,
  skills: [],
  activationRecords: [],
};

const audit = {
  eventKey: "55555555-5555-4555-8555-555555555555",
  tenantKey,
  projectKey,
  action: "activated" as const,
  actorKey: "66666666-6666-4666-8666-666666666666",
  actorName: "平台管理员",
  skillKey,
  version: "1.0.0",
  evaluationKey,
  recordedAt: "2026-08-10T08:00:00.000Z",
};

interface RecordedQuery {
  text: string;
  values?: readonly unknown[];
}

const fakePool = (responses: unknown[][]) => {
  const queries: RecordedQuery[] = [];
  const client: PostgresClient = {
    query: async (text, values) => {
      queries.push(values ? { text, values } : { text });
      return { rows: responses.shift() ?? [] };
    },
    release: () => undefined,
  };
  const pool: PostgresPool = { connect: async () => client };
  return { pool, queries };
};

describe("PostgresSkillRegistryRepository", () => {
  it("按租户、项目、Skill 和版本不可变保存实际制品字节", async () => {
    const database = fakePool([[], [], [], [], []]);
    const store = new PostgresSkillArtifactStore(database.pool);

    await store.put(manifest, artifactBytes);

    expect(database.queries.map((query) => query.text)).toEqual([
      "BEGIN",
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("SELECT artifact_hash"),
      expect.stringContaining("INSERT INTO forgex_skill_artifacts"),
      "COMMIT",
    ]);
    expect(database.queries[3]?.values?.slice(0, 6)).toEqual([
      tenantKey,
      projectKey,
      skillKey,
      "1.0.0",
      manifest.artifactHash,
      artifactBytes.byteLength,
    ]);
    expect(database.queries[3]?.values?.[6]).toEqual(
      Buffer.from(artifactBytes),
    );

    const reader = fakePool([
      [
        {
          artifactHash: manifest.artifactHash,
          sizeBytes: artifactBytes.byteLength,
          content: artifactBytes,
        },
      ],
    ]);
    await expect(
      new PostgresSkillArtifactStore(reader.pool).get(manifest),
    ).resolves.toEqual(Uint8Array.from(artifactBytes));
  });

  it("在项目级事务锁内原子保存快照和激活审计", async () => {
    const database = fakePool([[], [], [], [], [], []]);
    const repository = new PostgresSkillRegistryRepository(database.pool);

    await repository.transaction(tenantKey, projectKey, (transaction) => {
      expect(transaction.load()).toBeNull();
      transaction.save(snapshot);
      transaction.appendAudit(audit);
    });

    expect(database.queries.map((query) => query.text)).toEqual([
      "BEGIN",
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("SELECT state"),
      expect.stringContaining("INSERT INTO forgex_skill_registries"),
      expect.stringContaining("INSERT INTO forgex_skill_activation_audit"),
      "COMMIT",
    ]);
    expect(database.queries[1]?.values).toEqual([
      `${tenantKey}:${projectKey}:skills`,
    ]);
    expect(JSON.parse(String(database.queries[3]?.values?.[2]))).toEqual(
      snapshot,
    );
    expect(database.queries[4]?.values).toEqual([
      audit.eventKey,
      tenantKey,
      projectKey,
      skillKey,
      "1.0.0",
      evaluationKey,
      "activated",
      audit.actorKey,
      audit.actorName,
      audit.recordedAt,
    ]);
  });

  it("读取审计时校验租户项目范围并返回脱离数据库行的对象", async () => {
    const database = fakePool([[audit]]);
    const repository = new PostgresSkillRegistryRepository(database.pool);

    await expect(repository.listAudit(tenantKey, projectKey)).resolves.toEqual([
      audit,
    ]);

    const crossed = fakePool([
      [
        {
          ...audit,
          projectKey: "77777777-7777-4777-8777-777777777777",
        },
      ],
    ]);
    await expect(
      new PostgresSkillRegistryRepository(crossed.pool).listAudit(
        tenantKey,
        projectKey,
      ),
    ).rejects.toThrow("数据库中的 Skill 审计不属于查询范围");
  });

  it("迁移约束快照范围、版本格式、操作类型和审计外键", () => {
    const migration = readFileSync(
      new URL("../migrations/0006_skill_registry.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("PRIMARY KEY (tenant_key, project_key)");
    expect(migration).toContain(
      "PRIMARY KEY (tenant_key, project_key, skill_key, skill_version)",
    );
    expect(migration).toContain("CHECK (octet_length(content) = size_bytes)");
    expect(migration).toContain(
      "(state ->> 'projectKey') IS NOT DISTINCT FROM project_key::text",
    );
    expect(migration).toContain("action IN ('activated', 'rolled_back')");
    expect(migration).toContain(
      "REFERENCES forgex_skill_registries (tenant_key, project_key)",
    );
  });

  it("生产文档把 Skill 仓储迁移和共享注入接在扩展目录之后", () => {
    const readme = readFileSync(
      new URL("../../../README.md", import.meta.url),
      "utf8",
    );
    expect(readme.indexOf("0006_skill_registry.sql")).toBeGreaterThan(
      readme.indexOf("0005_extension_catalog.sql"),
    );
    expect(readme).toContain("PostgresSkillRegistryRepository");
    expect(readme).toContain("PostgresSkillArtifactStore");
  });
});
