import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { LifecycleService } from "@forgex/application";
import {
  PostgresLifecycleRepository,
  loadPostgresMigrations,
  runPostgresMigrations,
} from "@forgex/postgres";
import { createLifecycleFixture } from "./lifecycle-fixture.js";

const databaseUrl = process.env.FORGEX_TEST_DATABASE_URL;
describe("2.0 PostgreSQL 持久化闭环", () => {
  (databaseUrl ? it : it.skip)(
    "完整迁移、并发领取、交付关闭和新服务实例恢复审批及通知",
    async () => {
      if (!new URL(databaseUrl!).pathname.endsWith("_test"))
        throw new Error("只能使用以 _test 结尾的隔离数据库");
      const schema = `forgex_p0_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: databaseUrl, max: 1 });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema}`,
        max: 6,
      });
      let fixture:
        Awaited<ReturnType<typeof createLifecycleFixture>> | undefined;
      try {
        await runPostgresMigrations(
          pool,
          await loadPostgresMigrations(resolve("packages/postgres/migrations")),
        );
        fixture = await createLifecycleFixture(
          new PostgresLifecycleRepository(pool),
        );
        const created = await fixture.create();
        const services = [
          new LifecycleService(new PostgresLifecycleRepository(pool), fixture),
          new LifecycleService(new PostgresLifecycleRepository(pool), fixture),
        ];
        const claims = await Promise.all(
          services.map((service) =>
            service.claim(fixture!.executors[0]!.executor),
          ),
        );
        expect(claims.filter(Boolean)).toHaveLength(1);
        const leased = claims.find(Boolean)!;
        const result = await fixture.adapter.execute(
          leased,
          new AbortController().signal,
        );
        const { sign } = await import("node:crypto");
        const { canonicalLifecycleJson } =
          await import("@forgex/contracts/lifecycle");
        const payload = {
          schemaVersion: 2 as const,
          jobKey: leased.jobKey,
          fencingToken: leased.fencingToken!,
          inputDigest: leased.inputDigest,
          result,
        };
        await services[0]!.complete(fixture.executors[0]!.executor, {
          payload,
          signatureBase64: sign(
            null,
            Buffer.from(canonicalLifecycleJson(payload)),
            fixture.executors[0]!.privateKey,
          ).toString("base64"),
        });
        await fixture.runTo(created.workflowKey, "closed");
        const restored = await services[1]!.get(
          fixture.people.requester,
          created.workflowKey,
        );
        expect(restored.stage).toBe("closed");
        expect(
          restored.events.some((event) => event.detail.includes("设计")),
        ).toBe(true);
        const notices = await services[1]!.notifications(
          fixture.people.requester,
        );
        expect(notices.length).toBeGreaterThan(0);
        await services[0]!.acknowledge(
          fixture.people.requester,
          notices[0]!.notificationKey,
        );
        expect(
          (await services[1]!.notifications(fixture.people.requester))[0]!.read,
        ).toBe(true);
        const before = await pool.query(
          "SELECT state FROM forgex_lifecycle_states WHERE tenant_key = $1",
          [fixture.tenantKey],
        );
        expect(before.rows[0].state.productionOwners).toEqual([]);
        expect(
          before.rows[0].state.workflows[0].approvals.filter(
            (a: { stage: string }) => a.stage === "online_acceptance",
          ),
        ).toHaveLength(3);
        await expect(
          new PostgresLifecycleRepository(pool).transaction(
            fixture.tenantKey,
            (state) => {
              state.workflows.length = 0;
              throw new Error("模拟事务故障");
            },
          ),
        ).rejects.toThrow("模拟事务故障");
        expect(
          (
            await services[1]!.get(
              fixture.people.requester,
              created.workflowKey,
            )
          ).stage,
        ).toBe("closed");
      } finally {
        await fixture?.close();
        await pool.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    },
    60_000,
  );
});
