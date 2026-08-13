import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { WORKER_REQUIREMENT_COMPLETION_SUMMARY } from "@forgex/contracts";

import type { RequirementSpec } from "@forgex/contracts";
import { RequirementWorkflow } from "@forgex/domain";

import {
  PostgresRequirementRepository,
  type PostgresClient,
  type PostgresPool,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const requirementKey = "33333333-3333-4333-8333-333333333333";
const dispatchKey = "44444444-4444-4444-8444-444444444444";
const now = "2026-08-10T06:00:00.000Z";
const spec: RequirementSpec = {
  schemaVersion: 1,
  title: "访客预约",
  goal: "让访客到访过程更加顺畅",
  userStories: [],
  acceptanceCriteria: [
    {
      title: "访客可以提交预约",
      description: "填写完整信息后可以提交",
      priority: "must",
    },
  ],
  openQuestions: [],
};

const workflow = (key = requirementKey) => {
  const created = RequirementWorkflow.createFromSpec(spec, {
    tenantKey,
    projectKey,
    clock: () => new Date(now),
  });
  const snapshot = created.toSnapshot();
  return RequirementWorkflow.fromSnapshot({
    ...snapshot,
    requirementKey: key,
  });
};

interface RecordedQuery {
  text: string;
  values?: readonly unknown[];
}

const fakeDatabase = (options?: {
  respond?: (
    text: string,
    values: readonly unknown[] | undefined,
  ) => unknown[] | undefined;
}) => {
  const queries: RecordedQuery[] = [];
  let released = false;
  const client: PostgresClient = {
    query: async (text, values) => {
      queries.push(values ? { text, values } : { text });
      const responded = options?.respond?.(text, values);
      if (responded !== undefined) {
        return { rows: responded };
      }
      if (text.includes("SELECT created_at")) {
        return {
          rows: [
            {
              created_at: now,
              spec,
              workflow: workflow().toSnapshot(),
            },
          ],
        };
      }
      if (text.includes("UPDATE forgex_delivery_outbox")) {
        return { rows: [{ dispatch_key: dispatchKey }] };
      }
      return { rows: [] };
    },
    release: () => {
      released = true;
    },
  };
  const pool: PostgresPool = { connect: async () => client };
  return { pool, queries, wasReleased: () => released };
};

describe("PostgresRequirementRepository", () => {
  it("读取旧快照时用同一行的权威规格回填当前完整版本", async () => {
    const snapshot = workflow().toSnapshot();
    const legacySnapshot = {
      ...snapshot,
      schemaVersion: 1 as const,
      revisions: snapshot.revisions.map(
        ({ spec: _spec, contentState: _contentState, ...revision }) => ({
          ...revision,
          specHash: null,
        }),
      ),
    };
    const database = fakeDatabase({
      respond: (text) =>
        text.includes("SELECT created_at")
          ? [{ created_at: now, spec, workflow: legacySnapshot }]
          : undefined,
    });
    const repository = new PostgresRequirementRepository(database.pool);

    await repository.transaction(tenantKey, projectKey, async (transaction) => {
      const record = await transaction.find(requirementKey);
      expect(record?.workflow.listRevisionsForPeople()).toEqual([
        expect.objectContaining({
          revision: 1,
          contentState: "完整规格",
          spec,
        }),
      ]);
      transaction.save(record!);
    });

    const persisted = database.queries.find((query) =>
      query.text.startsWith("INSERT INTO forgex_requirements"),
    );
    expect(JSON.parse(String(persisted?.values?.[6]))).toMatchObject({
      schemaVersion: 2,
      revisions: [expect.objectContaining({ contentState: "complete", spec })],
    });
  });

  it("向前迁移允许验收审计进入数据库约束", () => {
    const migration = readFileSync(
      new URL(
        "../migrations/0003_requirement_acceptance_audit.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain("DROP CONSTRAINT IF EXISTS");
    expect(migration).toContain("'requirement.accepted'");
    expect(migration).toContain("ADD CONSTRAINT");
  });

  it("在同一项目事务中恢复聚合并提交需求、审计和 outbox", async () => {
    const database = fakeDatabase();
    const repository = new PostgresRequirementRepository(database.pool, {
      clock: () => new Date(now),
    });

    await repository.transaction(tenantKey, projectKey, async (transaction) => {
      const record = await transaction.find(requirementKey);
      expect(record?.workflow.toPeopleView().status).toBe("正在整理");
      transaction.save(record!);
      transaction.appendAudit({
        eventKey: "55555555-5555-4555-8555-555555555555",
        tenantKey,
        projectKey,
        requirementKey,
        action: "delivery.dispatched",
        actorKey: "66666666-6666-4666-8666-666666666666",
        actorName: "ForgeX 调度器",
        recordedAt: now,
      });
      transaction.appendDeliveryDispatch({
        dispatchKey,
        tenantKey,
        projectKey,
        repositoryKey: projectKey,
        requirementKey,
        requirementRevision: 1,
        title: spec.title,
        requiredCapabilities: ["typescript"],
        skills: [],
        requestedAt: now,
        dispatchedAt: null,
      });
    });

    await repository.transaction(tenantKey, projectKey, async (transaction) => {
      await expect(
        transaction.markDeliveryDispatched(dispatchKey, now),
      ).resolves.toBe(true);
    });

    expect(database.queries.map((query) => query.text)).toEqual([
      "BEGIN",
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("SELECT created_at"),
      expect.stringContaining("INSERT INTO forgex_requirements"),
      expect.stringContaining("INSERT INTO forgex_requirement_audit"),
      expect.stringContaining("INSERT INTO forgex_delivery_outbox"),
      "COMMIT",
      "BEGIN",
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("UPDATE forgex_delivery_outbox"),
      "COMMIT",
    ]);
    expect(database.queries[1]?.values).toEqual([`${tenantKey}:${projectKey}`]);
    expect(database.wasReleased()).toBe(true);
  });

  it("项目事务失败时回滚并释放连接", async () => {
    const database = fakeDatabase();
    const repository = new PostgresRequirementRepository(database.pool);

    await expect(
      repository.transaction(tenantKey, projectKey, () => {
        throw new Error("模拟需求事务失败");
      }),
    ).rejects.toThrow("模拟需求事务失败");

    expect(database.queries.at(-1)?.text).toBe("ROLLBACK");
    expect(database.wasReleased()).toBe(true);
  });

  it("提交阶段写审计失败时回滚已经写入的需求", async () => {
    const database = fakeDatabase({
      respond: (text) => {
        if (text.includes("INSERT INTO forgex_requirement_audit")) {
          throw new Error("模拟审计存储失败");
        }
        return undefined;
      },
    });
    const repository = new PostgresRequirementRepository(database.pool);

    await expect(
      repository.transaction(tenantKey, projectKey, async (transaction) => {
        const record = await transaction.find(requirementKey);
        transaction.save(record!);
        transaction.appendAudit({
          eventKey: "55555555-5555-4555-8555-555555555555",
          tenantKey,
          projectKey,
          requirementKey,
          action: "requirement.created",
          actorKey: "66666666-6666-4666-8666-666666666666",
          actorName: "产品负责人",
          recordedAt: now,
        });
      }),
    ).rejects.toThrow("模拟审计存储失败");

    expect(database.queries.map((query) => query.text)).toEqual([
      "BEGIN",
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("SELECT created_at"),
      expect.stringContaining("INSERT INTO forgex_requirements"),
      expect.stringContaining("INSERT INTO forgex_requirement_audit"),
      "ROLLBACK",
    ]);
    expect(database.queries.some((query) => query.text === "COMMIT")).toBe(
      false,
    );
    expect(database.wasReleased()).toBe(true);
  });

  it("列表由数据库稳定分页并拒绝聚合身份与外层记录不一致", async () => {
    const otherRequirementKey = "77777777-7777-4777-8777-777777777777";
    const database = fakeDatabase({
      respond: (text) =>
        text.includes("SELECT requirement_key")
          ? [
              {
                requirement_key: requirementKey,
                workflow: workflow().toSnapshot(),
                position: "10",
              },
              {
                requirement_key: otherRequirementKey,
                workflow: workflow(otherRequirementKey).toSnapshot(),
                position: "11",
              },
            ]
          : undefined,
    });
    const repository = new PostgresRequirementRepository(database.pool);

    const page = await repository.listForPeople(tenantKey, projectKey, {
      limit: 1,
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      requirementKey,
      view: { title: spec.title, status: "正在整理" },
    });
    expect(page.nextPosition).toBe(10);
    expect(database.queries.at(-1)?.values).toEqual([
      tenantKey,
      projectKey,
      0,
      2,
    ]);

    const disguised = fakeDatabase({
      respond: (text) =>
        text.includes("SELECT requirement_key")
          ? [
              {
                requirement_key: otherRequirementKey,
                workflow: workflow().toSnapshot(),
                position: "1",
              },
            ]
          : undefined,
    });
    await expect(
      new PostgresRequirementRepository(disguised.pool).listForPeople(
        tenantKey,
        projectKey,
        { limit: 20 },
      ),
    ).rejects.toThrow("身份与持久化范围");
  });

  it("按租户跨项目恢复待派发 outbox，同时保留项目过滤能力", async () => {
    const database = fakeDatabase({
      respond: (text) =>
        text.includes("FROM forgex_delivery_outbox")
          ? [
              {
                dispatch_key: dispatchKey,
                project_key: projectKey,
                repository_key: projectKey,
                requirement_key: requirementKey,
                requirement_revision: 1,
                title: spec.title,
                required_capabilities: ["typescript"],
                skills: [],
                requested_at: now,
                dispatched_at: null,
              },
            ]
          : undefined,
    });
    const repository = new PostgresRequirementRepository(database.pool);

    await expect(
      repository.listPendingDeliveryDispatches(tenantKey, null, 100),
    ).resolves.toEqual([
      expect.objectContaining({
        dispatchKey,
        tenantKey,
        projectKey,
        requirementKey,
        requirementRevision: 1,
      }),
    ]);
    expect(database.queries.at(-1)?.text).toContain(
      "WHERE tenant_key = $1 AND dispatched_at IS NULL",
    );
    expect(database.queries.at(-1)?.values).toEqual([tenantKey, 100]);

    await repository.listPendingDeliveryDispatches(tenantKey, projectKey, 20);
    expect(database.queries.at(-1)?.text).toContain(
      "WHERE tenant_key = $1 AND project_key = $2",
    );
    expect(database.queries.at(-1)?.values).toEqual([
      tenantKey,
      projectKey,
      20,
    ]);
  });

  it("读取审计时校验操作人身份并保持项目隔离", async () => {
    const eventKey = "55555555-5555-4555-8555-555555555555";
    const actorKey = "66666666-6666-4666-8666-666666666666";
    const database = fakeDatabase({
      respond: (text) =>
        text.includes("SELECT event_key")
          ? [
              {
                event_key: eventKey,
                requirement_key: requirementKey,
                action: "requirement.created",
                actor_key: actorKey,
                actor_name: " 产品负责人 ",
                recorded_at: now,
              },
            ]
          : undefined,
    });
    const repository = new PostgresRequirementRepository(database.pool);

    await expect(
      repository.listAuditEvents(tenantKey, projectKey),
    ).resolves.toEqual([
      {
        eventKey,
        tenantKey,
        projectKey,
        requirementKey,
        action: "requirement.created",
        actorKey,
        actorName: "产品负责人",
        recordedAt: now,
      },
    ]);
    expect(database.queries.at(-1)?.values).toEqual([tenantKey, projectKey]);

    const corrupted = fakeDatabase({
      respond: (text) =>
        text.includes("SELECT event_key")
          ? [
              {
                event_key: eventKey,
                requirement_key: requirementKey,
                action: "requirement.created",
                actor_key: "not-a-key",
                actor_name: "产品负责人",
                recorded_at: now,
              },
            ]
          : undefined,
    });
    await expect(
      new PostgresRequirementRepository(corrupted.pool).listAuditEvents(
        tenantKey,
        projectKey,
      ),
    ).rejects.toThrow("操作人标识格式不正确");
  });

  it("接受契约允许的 UUID v7 项目事务", async () => {
    const database = fakeDatabase();
    const repository = new PostgresRequirementRepository(database.pool);
    const tenantV7 = "019fe98a-8638-74b3-a37d-5d509ba9ac96";
    const projectV7 = "019fe98a-8638-74b3-a37d-5d509ba9ac97";

    await expect(
      repository.transaction(tenantV7, projectV7, () => "已锁定"),
    ).resolves.toBe("已锁定");
    expect(database.queries[1]?.values).toEqual([`${tenantV7}:${projectV7}`]);
  });

  it("持久化并按永久租约凭据收敛设备交付结果", async () => {
    const assignmentKey = "77777777-7777-4777-8777-777777777777";
    const database = fakeDatabase({
      respond: (text) =>
        text.startsWith("UPDATE forgex_delivery_runs")
          ? [{ requirement_key: requirementKey }]
          : undefined,
    });
    const repository = new PostgresRequirementRepository(database.pool);
    await repository.transaction(tenantKey, projectKey, (transaction) => {
      transaction.saveDeliveryRunResult({
        tenantKey,
        projectKey,
        repositoryKey: projectKey,
        requirementKey,
        requirementRevision: 1,
        assignmentKey,
        fencingToken: 9,
        gitHashAlgorithm: "sha1",
        baseCommit: "a".repeat(40),
        commitSha: "b".repeat(40),
        branchName: `forgex/${projectKey.slice(0, 8)}/${assignmentKey}`,
        summary: WORKER_REQUIREMENT_COMPLETION_SUMMARY,
        status: "completion_pending",
        submittedAt: now,
        completedAt: null,
      });
    });
    expect(
      database.queries.some((query) =>
        query.text.includes("INSERT INTO forgex_delivery_runs"),
      ),
    ).toBe(true);

    await expect(
      repository.transaction(tenantKey, projectKey, (transaction) =>
        transaction.markDeliveryRunCompleted(
          requirementKey,
          1,
          { assignmentKey, fencingToken: 9 },
          now,
        ),
      ),
    ).resolves.toBe(true);
    expect(
      database.queries.some((query) =>
        query.text.includes("status = 'completed'"),
      ),
    ).toBe(true);
  });

  it("交付运行迁移绑定仓库、提交和完成审计", () => {
    const migration = readFileSync(
      new URL("../migrations/0011_delivery_runs.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("ALTER TABLE forgex_delivery_outbox");
    expect(migration).toContain("repository_key uuid");
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS forgex_delivery_runs",
    );
    expect(migration).toContain(
      "UNIQUE (tenant_key, assignment_key, fencing_token)",
    );
    expect(migration).toContain(
      "CHECK (summary = '已生成本地提交，等待独立验证')",
    );
    expect(migration).toContain("'delivery.completed'");
    expect(migration).toContain("WHERE status = 'completion_pending'");
  });

  it("独立验证迁移约束证据唯一性、待验证查询索引和审计动作", () => {
    const migration = readFileSync(
      new URL("../migrations/0012_runner_verification.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS forgex_requirement_evidence",
    );
    expect(migration).toContain("PRIMARY KEY (tenant_key, evidence_key)");
    expect(migration).toContain(
      "UNIQUE (\n    tenant_key,\n    project_key,\n    requirement_key,\n    requirement_revision",
    );
    expect(migration).toContain("forgex_delivery_runs_verification_idx");
    expect(migration).toContain("WHERE status = 'completed'");
    expect(migration).toContain("'verification.preview_recorded'");
    expect(migration).toContain("'verification.completed'");
  });

  it("独立验证失败迁移绑定交付版本、审计动作和失败终态", () => {
    const migration = readFileSync(
      new URL("../migrations/0013_verification_failures.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS forgex_verification_failures",
    );
    expect(migration).toContain(
      "verification_completed_at timestamptz NOT NULL",
    );
    expect(migration).toContain(
      "PRIMARY KEY (\n    tenant_key,\n    project_key,\n    requirement_key,\n    requirement_revision",
    );
    expect(migration).toContain("REFERENCES forgex_delivery_runs");
    expect(migration).toContain("'verification.failed'");
  });

  it("需求版本迁移允许追加式修订审计", () => {
    const migration = readFileSync(
      new URL("../migrations/0016_requirement_revisions.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("DROP CONSTRAINT IF EXISTS");
    expect(migration).toContain("'requirement.revised'");
    expect(migration).toContain("ADD CONSTRAINT");
  });

  it("交付 Skill 迁移为派发记录增加有界选择", () => {
    const migration = readFileSync(
      new URL("../migrations/0017_delivery_skills.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("ADD COLUMN IF NOT EXISTS skills jsonb");
    expect(migration).toContain("jsonb_typeof(skills) = 'array'");
    expect(migration).toContain("jsonb_array_length(skills) <= 10");
  });

  it("在需求事务内持久化证据防重放记录", async () => {
    const evidenceKey = "77777777-7777-4777-8777-777777777777";
    const database = fakeDatabase({
      respond: (text) =>
        text.includes("INSERT INTO forgex_requirement_evidence")
          ? [{ evidence_key: evidenceKey }]
          : undefined,
    });
    const repository = new PostgresRequirementRepository(database.pool);

    await repository.transaction(tenantKey, projectKey, (transaction) => {
      transaction.appendVerificationEvidence({
        tenantKey,
        projectKey,
        requirementKey,
        requirementRevision: 1,
        evidenceKey,
        evidenceDigest: "a".repeat(64),
        runnerKey: "88888888-8888-4888-8888-888888888888",
        keyId: "99999999-9999-4999-8999-999999999999",
        recordedAt: now,
      });
    });

    expect(
      database.queries.find((query) =>
        query.text.includes("INSERT INTO forgex_requirement_evidence"),
      )?.values,
    ).toEqual([
      tenantKey,
      projectKey,
      requirementKey,
      1,
      evidenceKey,
      "a".repeat(64),
      "88888888-8888-4888-8888-888888888888",
      "99999999-9999-4999-8999-999999999999",
      now,
    ]);
  });

  it("按项目、仓库和已完成状态读取待独立验证交付", async () => {
    const database = fakeDatabase({
      respond: (text) =>
        text.includes("list")
          ? []
          : text.includes("INNER JOIN forgex_requirements")
            ? [
                {
                  repository_key: projectKey,
                  requirement_key: requirementKey,
                  requirement_revision: 1,
                  assignment_key: dispatchKey,
                  fencing_token: 2,
                  git_hash_algorithm: "sha1",
                  base_commit: "a".repeat(40),
                  commit_sha: "b".repeat(40),
                  branch_name: `forgex/${projectKey.slice(0, 8)}/${dispatchKey}`,
                  summary: WORKER_REQUIREMENT_COMPLETION_SUMMARY,
                  status: "completed",
                  submitted_at: now,
                  completed_at: now,
                },
              ]
            : undefined,
    });
    const repository = new PostgresRequirementRepository(database.pool);

    await expect(
      repository.listDeliveryRunsAwaitingVerification(
        tenantKey,
        projectKey,
        projectKey,
        20,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        requirementKey,
        status: "completed",
        commitSha: "b".repeat(40),
      }),
    ]);
    const query = database.queries.find((item) =>
      item.text.includes("INNER JOIN forgex_requirements"),
    );
    expect(query?.text).toContain("run.status = 'completed'");
    expect(query?.text).toContain("workflow ->> 'status' = 'inDelivery'");
    expect(query?.text).toContain(
      "NOT EXISTS (SELECT 1 FROM forgex_verification_failures",
    );
    expect(query?.values).toEqual([tenantKey, projectKey, projectKey, 20]);
  });

  it("读取待撤销交付并持久化 Worker 撤销完成时间", async () => {
    const cancelledAt = "2026-08-10T06:01:00.000Z";
    const completedAt = "2026-08-10T06:02:00.000Z";
    const database = fakeDatabase({
      respond: (text) =>
        text.includes("cancelled_at IS NOT NULL") && text.startsWith("SELECT")
          ? [
              {
                dispatch_key: dispatchKey,
                project_key: projectKey,
                repository_key: projectKey,
                requirement_key: requirementKey,
                requirement_revision: 1,
                title: spec.title,
                required_capabilities: [],
                skills: [],
                requested_at: now,
                dispatched_at: now,
                cancelled_at: cancelledAt,
                cancellation_completed_at: null,
              },
            ]
          : undefined,
    });
    const repository = new PostgresRequirementRepository(database.pool);

    await expect(
      repository.listPendingDeliveryCancellations(tenantKey, 10),
    ).resolves.toEqual([
      expect.objectContaining({
        dispatchKey,
        cancelledAt,
        cancellationCompletedAt: null,
      }),
    ]);
    await repository.transaction(tenantKey, projectKey, async (transaction) => {
      await expect(
        transaction.markDeliveryCancellationCompleted(dispatchKey, completedAt),
      ).resolves.toBe(true);
    });

    expect(
      database.queries.find((query) =>
        query.text.includes("SET cancellation_completed_at"),
      )?.values,
    ).toEqual([tenantKey, projectKey, dispatchKey, completedAt]);
  });

  it("迁移脚本建立需求、审计和可靠 outbox 的数据库约束", () => {
    const migration = readFileSync(
      new URL(
        "../migrations/0002_requirement_control_plane.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS forgex_requirements",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS forgex_requirement_audit",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS forgex_delivery_outbox",
    );
    expect(migration).toContain(
      "UNIQUE (tenant_key, project_key, requirement_key, requirement_revision)",
    );
    expect(
      migration.match(
        /FOREIGN KEY \(tenant_key, project_key, requirement_key\)/g,
      ),
    ).toHaveLength(2);
    expect(migration).toContain("jsonb_typeof(spec) = 'object'");
    expect(migration).toContain("action IN (");
    expect(migration).toContain(
      "jsonb_typeof(required_capabilities) = 'array'",
    );
    expect(migration).toContain(
      "dispatched_at IS NULL OR dispatched_at >= requested_at",
    );
    expect(migration).toContain("WHERE dispatched_at IS NULL");
  });

  it("终止迁移同时保存撤销意图和撤销完成事实", () => {
    const migration = readFileSync(
      new URL("../migrations/0022_delivery_termination.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("cancelled_at timestamptz");
    expect(migration).toContain("cancellation_completed_at timestamptz");
    expect(migration).toContain("cancellation_completed_at >= cancelled_at");
    expect(migration).toContain("'delivery.terminated'");
  });

  it("过程事件以结构化 JSON 幂等写入，并按设备序号返回最近记录", async () => {
    const assignmentKey = "77777777-7777-4777-8777-777777777777";
    const firstEventKey = "88888888-8888-4888-8888-888888888888";
    const secondEventKey = "99999999-9999-4999-8999-999999999999";
    const database = fakeDatabase({
      respond: (text) => {
        if (
          text.startsWith("INSERT INTO forgex_requirement_execution_events")
        ) {
          return [{ event_key: firstEventKey }];
        }
        if (
          text.startsWith(
            "SELECT event_key, requirement_key, requirement_revision, assignment_key, sequence, occurred_at, event FROM forgex_requirement_execution_events WHERE tenant_key",
          )
        ) {
          return [
            {
              event_key: secondEventKey,
              requirement_key: requirementKey,
              requirement_revision: 1,
              assignment_key: assignmentKey,
              sequence: 2,
              occurred_at: "2026-08-13T04:00:02.000Z",
              event: {
                kind: "file_change",
                changes: [{ path: "src/App.tsx", kind: "update" }],
                status: "completed",
              },
            },
            {
              event_key: firstEventKey,
              requirement_key: requirementKey,
              requirement_revision: 1,
              assignment_key: assignmentKey,
              sequence: 1,
              occurred_at: "2026-08-13T04:00:01.000Z",
              event: {
                kind: "tool",
                tool: "search_workspace_text",
                status: "completed",
              },
            },
          ];
        }
        return undefined;
      },
    });
    const repository = new PostgresRequirementRepository(database.pool);

    await repository.transaction(tenantKey, projectKey, async (transaction) => {
      await expect(
        transaction.appendDeliveryExecutionEvent({
          eventKey: firstEventKey,
          tenantKey,
          projectKey,
          requirementKey,
          requirementRevision: 1,
          assignmentKey,
          sequence: 1,
          occurredAt: "2026-08-13T04:00:01.000Z",
          event: {
            kind: "tool",
            tool: "search_workspace_text",
            status: "completed",
          },
        }),
      ).resolves.toBe(true);
      await expect(
        transaction.listDeliveryExecutionEvents(requirementKey, 1, 100),
      ).resolves.toEqual([
        expect.objectContaining({ eventKey: firstEventKey, sequence: 1 }),
        expect.objectContaining({ eventKey: secondEventKey, sequence: 2 }),
      ]);
    });

    expect(
      database.queries
        .find((query) =>
          query.text.startsWith(
            "INSERT INTO forgex_requirement_execution_events",
          ),
        )
        ?.values?.at(-1),
    ).toBe(
      JSON.stringify({
        kind: "tool",
        tool: "search_workspace_text",
        status: "completed",
      }),
    );
    expect(
      database.queries.find((query) =>
        query.text.startsWith(
          "INSERT INTO forgex_requirement_execution_events",
        ),
      )?.text,
    ).toContain("COALESCE(MAX(sequence), 0) + 1");
    expect(
      database.queries.find((query) =>
        query.text.startsWith(
          "SELECT event_key, requirement_key, requirement_revision, assignment_key, sequence, occurred_at, event FROM forgex_requirement_execution_events WHERE tenant_key",
        ),
      )?.text,
    ).toContain("ORDER BY occurred_at DESC, sequence DESC");
  });

  it("过程事件迁移只保存结构化摘要，并按任务序号防止重复", () => {
    const migration = readFileSync(
      new URL(
        "../migrations/0023_requirement_execution_events.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS forgex_requirement_execution_events",
    );
    expect(migration).toContain("event jsonb NOT NULL");
    expect(migration).toContain("jsonb_typeof(event) = 'object'");
    expect(migration).toContain(
      "UNIQUE (tenant_key, assignment_key, sequence)",
    );
    expect(migration).toContain(
      "FOREIGN KEY (tenant_key, project_key, requirement_key)",
    );
  });
});
