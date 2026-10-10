import { randomUUID } from "node:crypto";
import { mkdir, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { createLifecycleFixture } from "./lifecycle-fixture.js";

// 只在用户主动运行实时验收命令时消耗当前账号额度，普通回归不调用模型。
describe.skipIf(process.env.FORGEX_LIVE_AI !== "1")(
  "2.0 真实 AI 与审批完整隔离交付",
  () => {
    it(
      "真实模型生成方案与代码，设计驳回阻止开发，独立测试、三方放行、关闭及 Bug 修复恢复",
      async () => {
        const evidence = path.resolve(
          process.env.FORGEX_AI_EVIDENCE_PATH ?? ".forgex-local/p0-ai",
        );
        await mkdir(evidence, { recursive: true, mode: 0o700 });
        const records: unknown[] = [];
        const fixture = await createLifecycleFixture(undefined, {
          realAI: true,
          onAgentResult: async (record) => {
            records.push(record);
            await mkdir(evidence, { recursive: true, mode: 0o700 });
            await writeFile(
              path.join(evidence, "agent-results.json"),
              JSON.stringify(records, null, 2),
              { mode: 0o600 },
            );
            console.log(
              `真实 Agent 回执：${(record as { stage: string }).stage}`,
            );
          },
        });
        try {
          const created = await fixture.create();
          const firstDesign = await fixture.runTo(
            created.workflowKey,
            "design_review",
          );
          expect(firstDesign.artifacts.some((a) => a.kind === "design")).toBe(
            true,
          );
          expect(await fixture.runtimes.agent!.tick()).toBe(false);
          const unauthorized = await fixture.request(
            "requester",
            "POST",
            `/api/v2/lifecycle/${created.workflowKey}/decisions`,
            {
              schemaVersion: 2,
              requestKey: randomUUID(),
              expectedVersion: firstDesign.version,
              role: "developer",
              decision: "approve",
              reason: "不应由需求方代替独立设计审核",
            },
          );
          expect(unauthorized.statusCode).toBe(409);
          expect((await fixture.get(created.workflowKey)).stage).toBe(
            "design_review",
          );
          const rejection = await fixture.request(
            "developer",
            "POST",
            `/api/v2/lifecycle/${created.workflowKey}/decisions`,
            {
              schemaVersion: 2,
              requestKey: randomUUID(),
              expectedVersion: firstDesign.version,
              role: "developer",
              decision: "reject",
              reason:
                "隔离验收演练：请明确未知编号返回 404，并保留原数据兼容性",
            },
          );
          expect(rejection.statusCode).toBe(200);
          expect(rejection.json().data.stage).toBe("design_ai");
          expect(
            records.filter(
              (r) => (r as { stage: string }).stage === "development",
            ),
          ).toHaveLength(0);
          await fixture.runTo(created.workflowKey, "design_review");
          const staging = await fixture.runTo(
            created.workflowKey,
            "staging_acceptance",
          );
          console.log(
            "设计独立审核及真实代码自测、测试报告、隔离测试部署均完成",
          );
          const url = staging.artifacts.find(
            (a) => a.kind === "deployment",
          )!.url!;
          const payload = {
            name: "真实 AI 验收访客",
            visitAt: "2030-01-01T10:00:00Z",
            requestKey: randomUUID(),
          };
          const response = await fetch(`${url}/appointments`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          expect(response.status).toBe(201);
          const appointment = (await response.json()) as { id: string };
          expect(
            (await fetch(`${url}/appointments/${appointment.id}`)).status,
          ).toBe(200);
          await fixture.approve(created.workflowKey, "requester");
          await fixture.approve(created.workflowKey, "developer");
          await fixture.approve(created.workflowKey, "production_ops");
          expect((await fixture.get(created.workflowKey)).stage).toBe(
            "release_approval",
          );
          expect(await fixture.runtimes.production!.tick()).toBe(false);
          await fixture.approve(created.workflowKey, "requester");
          await fixture.runtimes.production!.tick();
          const online = await fixture.get(created.workflowKey);
          expect(online.stage).toBe("online_acceptance");
          const code = online.artifacts.find((a) => a.kind === "code")!;
          const production = online.artifacts
            .filter((a) => a.kind === "deployment")
            .at(-1)!;
          expect(production.technical).toEqual(code.technical);
          const productionAppointment = (await fetch(
            `${production.url}/appointments`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            },
          ).then((r) => r.json())) as { id: string };
          await fixture.runTo(created.workflowKey, "closed");
          console.log(
            "首次真实 AI 交付已完成三方验收并关闭；开始关联 Bug 修复",
          );
          const bugResponse = await fixture.request(
            "requester",
            "POST",
            `/api/v2/lifecycle/${created.workflowKey}/bugs`,
            {
              schemaVersion: 2,
              requestKey: randomUUID(),
              title: "预约缺少确认说明",
              description:
                "成功创建、幂等重试和成功查询均返回 display=预约已确认；仅为响应附加字段，不存入预约记录，已有记录同样返回，无需迁移；保留原接口和数据。以上细则已确认。",
              severity: "minor",
            },
          );
          expect(bugResponse.statusCode).toBe(201);
          const bug = bugResponse.json().data;
          const repair = await fixture.request(
            "developer",
            "POST",
            `/api/v2/bugs/${bug.bugKey}/actions`,
            {
              schemaVersion: 2,
              requestKey: randomUUID(),
              action: "start_repair",
            },
          );
          expect(repair.statusCode).toBe(200);
          const repairKey = repair.json().data.repairWorkflowKey;
          expect(
            (
              await fixture.request(
                "requester",
                "POST",
                `/api/v2/bugs/${bug.bugKey}/actions`,
                {
                  schemaVersion: 2,
                  requestKey: randomUUID(),
                  action: "resolve",
                },
              )
            ).statusCode,
          ).toBe(409);
          const repaired = await fixture.runTo(repairKey, "online_acceptance");
          const repairedUrl = repaired.artifacts
            .filter((a) => a.kind === "deployment")
            .at(-1)!.url!;
          expect(
            await fetch(
              `${repairedUrl}/appointments/${productionAppointment.id}`,
            ).then((r) => r.json()),
          ).toMatchObject({
            id: productionAppointment.id,
            display: "预约已确认",
          });
          const repairAppointment = await fetch(`${repairedUrl}/appointments`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...payload, requestKey: randomUUID() }),
          }).then((r) => r.json());
          expect(repairAppointment.display).toBe("预约已确认");
          const rollback = await fixture.request(
            "requester",
            "POST",
            `/api/v2/lifecycle/${repairKey}/decisions`,
            {
              schemaVersion: 2,
              requestKey: randomUUID(),
              expectedVersion: repaired.version,
              role: "requester",
              decision: "reject",
              reason: "隔离恢复演练：恢复上一已验收制品",
            },
          );
          expect(rollback.statusCode).toBe(200);
          await fixture.runTo(repairKey, "production_rollback");
          await fixture.runtimes.production!.tick();
          expect((await fixture.get(repairKey)).stage).toBe("development");
          const restored = await fetch(`${production.url}/health`).then((r) =>
            r.json(),
          );
          expect(restored.artifactDigest).toBe(code.technical!.artifactDigest);
          console.log("隔离恢复通过；重新生成修复代码并经过整条批准链");
          await fixture.runTo(repairKey, "closed");
          const resolved = await fixture.request(
            "requester",
            "POST",
            `/api/v2/bugs/${bug.bugKey}/actions`,
            { schemaVersion: 2, requestKey: randomUUID(), action: "resolve" },
          );
          expect(resolved.json().data.status).toBe("resolved");
          const snapshot = await fixture.repository.transaction(
            fixture.tenantKey,
            (state) => structuredClone(state),
          );
          expect(snapshot.workflows.every((w) => w.stage === "closed")).toBe(
            true,
          );
          const threads = (records as { threadId: string }[]).map(
            (r) => r.threadId,
          );
          expect(threads.every(Boolean)).toBe(true);
          expect(new Set(threads).size).toBe(threads.length);
          const notifications = (
            await fixture.request("requester", "GET", "/api/v2/notifications")
          ).json().data;
          await writeFile(
            path.join(evidence, "workflow-evidence.json"),
            JSON.stringify(
              {
                schemaVersion: 1,
                environment: "isolated_loopback",
                approvalMode: "six_test_role_fixtures",
                modelCallCount: records.length,
                workflows: snapshot.workflows,
                bugs: snapshot.bugs,
                notifications,
              },
              null,
              2,
            ),
            { mode: 0o600 },
          );
          await cp(
            path.join(fixture.root, "artifacts"),
            path.join(evidence, "artifacts"),
            { recursive: true },
          );
          await cp(
            path.join(fixture.root, "ai-worktrees"),
            path.join(evidence, "agent-workspaces"),
            {
              recursive: true,
              filter: (source) => path.basename(source) !== ".git",
            },
          );
        } finally {
          await fixture.close();
        }
      },
      30 * 60_000,
    );
  },
);
