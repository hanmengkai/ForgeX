import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLifecycleFixture } from "./lifecycle-fixture.js";

describe("2.0 隔离样板真实交付闭环", () => {
  it("需求、独立设计审核、真实测试与部署、三方验收和 Bug 修复完整往返", async () => {
    const fixture = await createLifecycleFixture();
    try {
      const created = await fixture.create();
      const design = await fixture.runTo(created.workflowKey, "design_review");
      expect(design.artifacts.some((a) => a.kind === "design")).toBe(true);
      const bypass = await fixture.app.inject({
        method: "POST",
        url: "/api/v2/executor/claim",
        headers: { authorization: `Lifecycle ${fixture.executors[0]!.token}` },
        payload: { schemaVersion: 2 },
      });
      expect(bypass.json().data).toBeNull();
      const staging = await fixture.runTo(
        created.workflowKey,
        "staging_acceptance",
      );
      const stagingUrl = staging.artifacts.find(
        (a) => a.kind === "deployment",
      )!.url!;
      const response = await fetch(`${stagingUrl}/appointments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "验收访客",
          visitAt: "2030-01-01T10:00:00Z",
          requestKey: randomUUID(),
        }),
      });
      expect(response.status).toBe(201);
      expect(((await response.json()) as { id: string }).id).toMatch(
        /^[a-f0-9-]{36}$/u,
      );
      expect(
        (await fixture.approve(created.workflowKey, "requester")).stage,
      ).toBe("release_approval");
      await fixture.approve(created.workflowKey, "developer");
      await fixture.approve(created.workflowKey, "production_ops");
      expect((await fixture.get(created.workflowKey)).stage).toBe(
        "release_approval",
      );
      await fixture.approve(created.workflowKey, "requester");
      await fixture.runtimes.production!.tick();
      const online = await fixture.get(created.workflowKey);
      expect(online.stage).toBe("online_acceptance");
      const code = online.artifacts.find((a) => a.kind === "code")!;
      const production = online.artifacts
        .filter((a) => a.kind === "deployment")
        .at(-1)!;
      expect(production.technical).toEqual(code.technical);
      const health = (await fetch(`${production.url}/health`).then((r) =>
        r.json(),
      )) as { artifactDigest: string };
      expect(health.artifactDigest).toBe(code.technical!.artifactDigest);
      await fixture.runTo(created.workflowKey, "closed");
      const original = await fixture.repository.transaction(
        fixture.tenantKey,
        (state) =>
          structuredClone(
            state.workflows.find((s) => s.workflowKey === created.workflowKey)!,
          ),
      );
      const bugResponse = await fixture.request(
        "requester",
        "POST",
        `/api/v2/lifecycle/${created.workflowKey}/bugs`,
        {
          schemaVersion: 2,
          requestKey: randomUUID(),
          title: "预约缺少确认说明",
          description: "预约响应需要显示明确的确认说明",
          severity: "minor",
        },
      );
      expect(bugResponse.statusCode).toBe(201);
      const bug = bugResponse.json().data;
      const repairResponse = await fixture.request(
        "developer",
        "POST",
        `/api/v2/bugs/${bug.bugKey}/actions`,
        { schemaVersion: 2, requestKey: randomUUID(), action: "start_repair" },
      );
      expect(repairResponse.statusCode).toBe(200);
      const repairKey = repairResponse.json().data.repairWorkflowKey as string;
      const earlyResolve = await fixture.request(
        "requester",
        "POST",
        `/api/v2/bugs/${bug.bugKey}/actions`,
        { schemaVersion: 2, requestKey: randomUUID(), action: "resolve" },
      );
      expect(earlyResolve.statusCode).toBe(409);
      const repaired = await fixture.runTo(repairKey, "online_acceptance");
      const repairedProduction = repaired.artifacts
        .filter((a) => a.kind === "deployment")
        .at(-1)!;
      const appointment = (await fetch(
        `${repairedProduction.url}/appointments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "修复验收访客",
            visitAt: "2030-01-01T10:00:00Z",
            requestKey: randomUUID(),
          }),
        },
      ).then((r) => r.json())) as { display: string };
      expect(appointment.display).toBe("预约已确认");
      const rejection = await fixture.request(
        "requester",
        "POST",
        `/api/v2/lifecycle/${repairKey}/decisions`,
        {
          schemaVersion: 2,
          requestKey: randomUUID(),
          expectedVersion: repaired.version,
          role: "requester",
          decision: "reject",
          reason: "样板故障演练：恢复上一已验收制品",
        },
      );
      expect(rejection.statusCode).toBe(200);
      expect(rejection.json().data.stage).toBe("recovery_approval");
      await fixture.runTo(repairKey, "production_rollback");
      await fixture.runtimes.production!.tick();
      expect((await fixture.get(repairKey)).stage).toBe("development");
      const restoredHealth = (await fetch(`${production.url}/health`).then(
        (r) => r.json(),
      )) as { artifactDigest: string };
      expect(restoredHealth.artifactDigest).toBe(
        code.technical!.artifactDigest,
      );
      await fixture.runTo(repairKey, "closed");
      const resolve = await fixture.request(
        "requester",
        "POST",
        `/api/v2/bugs/${bug.bugKey}/actions`,
        { schemaVersion: 2, requestKey: randomUUID(), action: "resolve" },
      );
      expect(resolve.json().data.status).toBe("resolved");
      const after = await fixture.repository.transaction(
        fixture.tenantKey,
        (state) =>
          state.workflows.find((s) => s.workflowKey === created.workflowKey)!,
      );
      expect(after.stage).toBe("closed");
      expect(after.approvals).toEqual(original.approvals);
      expect(after.artifacts).toEqual(original.artifacts);
      const notifications = await fixture.request(
        "requester",
        "GET",
        "/api/v2/notifications",
      );
      expect(
        notifications
          .json()
          .data.some(
            (n: { detail: string }) => n.detail === "需求方测试环境验收",
          ),
      ).toBe(true);
      const lastProductionJob = await fixture.repository.transaction(
        fixture.tenantKey,
        (state) =>
          state.workflows
            .find((s) => s.workflowKey === repairKey)!
            .jobs.filter((j) => j.stage === "production_deploy")
            .at(-1)!,
      );
      await fixture.adapter.close();
      expect(
        await fixture.adapter.recover(
          lastProductionJob,
          new AbortController().signal,
        ),
      ).toMatchObject({ status: "blocked" });
    } finally {
      await fixture.close();
    }
  }, 60_000);
  it("拒绝人员伪装执行器、跨需求方访问以及缺失 CSRF 的浏览器审批", async () => {
    const fixture = await createLifecycleFixture();
    try {
      const flow = await fixture.create();
      const context = await fixture.request(
        "requester",
        "GET",
        "/api/v2/lifecycle/context",
      );
      expect(context.json().data.roles).toEqual(["requester"]);
      const invalidFilter = await fixture.request(
        "requester",
        "GET",
        "/api/v2/lifecycle?unexpected=true",
      );
      expect(invalidFilter.statusCode).toBe(422);
      const invalidKey = await fixture.request(
        "requester",
        "GET",
        "/api/v2/lifecycle/not-a-key",
      );
      expect(invalidKey.statusCode).toBe(422);
      const prematureBug = await fixture.request(
        "requester",
        "POST",
        `/api/v2/lifecycle/${flow.workflowKey}/bugs`,
        {
          schemaVersion: 2,
          requestKey: randomUUID(),
          title: "尚未关闭的交付问题",
          description: "应通过本轮异议处理",
          severity: "minor",
        },
      );
      expect(prematureBug.statusCode).toBe(409);
      const notices = await fixture.request(
        "requester",
        "GET",
        "/api/v2/notifications",
      );
      const noticeKey = notices.json().data[0].notificationKey;
      const invalidRead = await fixture.request(
        "requester",
        "POST",
        `/api/v2/notifications/${noticeKey}/read`,
        { schemaVersion: 1 },
      );
      expect(invalidRead.statusCode).toBe(422);
      const read = await fixture.request(
        "requester",
        "POST",
        `/api/v2/notifications/${noticeKey}/read`,
        { schemaVersion: 2 },
      );
      expect(read.statusCode).toBe(204);
      expect(
        (
          await fixture.request("requester", "GET", "/api/v2/notifications")
        ).json().data[0].read,
      ).toBe(true);
      const result = await fixture.request(
        "requester",
        "POST",
        "/api/v2/executor/claim",
        { schemaVersion: 2 },
      );
      expect(result.statusCode).toBe(401);
      const legacy = await fixture.request(
        "requester",
        "GET",
        "/api/v1/extensions",
      );
      expect(legacy.statusCode).toBe(403);
      const login = await fixture.app.inject({
        method: "POST",
        url: "/api/v1/session",
        headers: { "x-forgex-csrf": "1" },
        payload: {
          schemaVersion: 1,
          username: fixture.people.requester.username,
          password: "P0-Sample-2026!",
        },
      });
      expect(login.statusCode).toBe(200);
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      const csrf = await fixture.app.inject({
        method: "POST",
        url: `/api/v2/lifecycle/${flow.workflowKey}/decisions`,
        headers: { cookie },
        payload: {
          schemaVersion: 2,
          requestKey: randomUUID(),
          expectedVersion: flow.version,
          role: "requester",
          decision: "approve",
          reason: "没有 CSRF",
        },
      });
      expect(csrf.statusCode).toBe(403);
    } finally {
      await fixture.close();
    }
  });
  it("同一生产环境串行发布，首次上线无法恢复上一版本时保持阻塞和环境占用", async () => {
    const fixture = await createLifecycleFixture();
    try {
      const first = await fixture.create();
      await fixture.runTo(first.workflowKey, "online_acceptance");
      const second = await fixture.create();
      await fixture.runTo(second.workflowKey, "production_deploy");
      expect(await fixture.runtimes.production!.tick()).toBe(false);
      const online = await fixture.get(first.workflowKey);
      const rejection = await fixture.request(
        "requester",
        "POST",
        `/api/v2/lifecycle/${first.workflowKey}/decisions`,
        {
          schemaVersion: 2,
          requestKey: randomUUID(),
          expectedVersion: online.version,
          role: "requester",
          decision: "reject",
          reason: "首次上线故障演练，请恢复上一已验收版本",
        },
      );
      expect(rejection.statusCode).toBe(200);
      await fixture.runTo(first.workflowKey, "production_rollback");
      expect(await fixture.runtimes.production!.tick()).toBe(true);
      const blocked = await fixture.get(first.workflowKey);
      expect(blocked.stage).toBe("production_rollback");
      expect(blocked.blockedReason).toContain("上一制品");
      expect(await fixture.runtimes.production!.tick()).toBe(false);
      expect((await fixture.get(second.workflowKey)).stage).toBe(
        "production_deploy",
      );
    } finally {
      await fixture.close();
    }
  }, 60_000);
});
