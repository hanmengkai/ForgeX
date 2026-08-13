import { describe, expect, it, vi } from "vitest";

import { RequirementSpecSchema } from "@forgex/contracts";
import { RequirementWorkflow } from "@forgex/domain";

import {
  InMemoryRequirementRepository,
  RequirementApplicationService,
  type RequirementRecord,
  type AuthenticatedPrincipal,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const repositoryKey = "44444444-4444-4444-8444-444444444444";
const principal: AuthenticatedPrincipal = {
  actorKey: "33333333-3333-4333-8333-333333333333",
  actorName: "产品负责人",
  tenantKey,
  roles: ["product_owner"],
};
const spec = RequirementSpecSchema.parse({
  schemaVersion: 1,
  title: "访客预约",
  goal: "让访客到访过程更顺畅",
  userStories: [],
  acceptanceCriteria: [
    {
      title: "访客可以提交预约",
      description: "填写必要信息后能够提交预约",
      priority: "must",
    },
  ],
  openQuestions: [],
});

describe("RequirementApplicationService", () => {
  it("执行中的需求按事件顺序返回中文化的 Codex 过程记录", async () => {
    const repository = new InMemoryRequirementRepository();
    const service = new RequirementApplicationService({
      repository,
      projectKey,
      repositoryKey,
    });
    const created = await service.create(principal, spec);
    await service.submitForConfirmation(principal, created.requirementKey);
    await service.confirm(principal, created.requirementKey);
    await service.requestDelivery(principal, created.requirementKey, {
      schemaVersion: 1,
      requiredCapabilities: [],
    });

    await service.recordExecutionEvent(tenantKey, {
      eventKey: "66666666-6666-4666-8666-666666666666",
      assignmentKey: "77777777-7777-4777-8777-777777777777",
      requirementKey: created.requirementKey,
      requirementRevision: 1,
      sequence: 1,
      occurredAt: "2026-08-13T04:00:00.000Z",
      event: { kind: "lifecycle", status: "started" },
    });
    await service.recordExecutionEvent(tenantKey, {
      eventKey: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      assignmentKey: "77777777-7777-4777-8777-777777777777",
      requirementKey: created.requirementKey,
      requirementRevision: 1,
      sequence: 1,
      occurredAt: "2026-08-13T04:00:00.500Z",
      event: {
        kind: "tool",
        tool: "list_workspace",
        status: "started",
      },
    });
    await service.recordExecutionEvent(tenantKey, {
      eventKey: "88888888-8888-4888-8888-888888888888",
      assignmentKey: "77777777-7777-4777-8777-777777777777",
      requirementKey: created.requirementKey,
      requirementRevision: 1,
      sequence: 3,
      occurredAt: "2026-08-13T04:00:02.000Z",
      event: {
        kind: "file_change",
        changes: [{ path: "src/App.tsx", kind: "update" }],
        status: "completed",
      },
    });
    await service.recordExecutionEvent(tenantKey, {
      eventKey: "99999999-9999-4999-8999-999999999999",
      assignmentKey: "77777777-7777-4777-8777-777777777777",
      requirementKey: created.requirementKey,
      requirementRevision: 1,
      sequence: 2,
      occurredAt: "2026-08-13T04:00:01.000Z",
      event: {
        kind: "tool",
        tool: "search_workspace_text",
        status: "completed",
      },
    });
    await service.recordExecutionEvent(tenantKey, {
      eventKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      assignmentKey: "77777777-7777-4777-8777-777777777777",
      requirementKey: created.requirementKey,
      requirementRevision: 1,
      sequence: 4,
      occurredAt: "2026-08-13T04:00:03.000Z",
      event: {
        kind: "command",
        category: "test",
        status: "failed",
        exitCode: 1,
      },
    });
    await service.recordExecutionEvent(tenantKey, {
      eventKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      assignmentKey: "77777777-7777-4777-8777-777777777777",
      requirementKey: created.requirementKey,
      requirementRevision: 1,
      sequence: 5,
      occurredAt: "2026-08-13T04:00:04.000Z",
      event: { kind: "lifecycle", status: "completed" },
    });
    await service.recordExecutionEvent(tenantKey, {
      eventKey: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      assignmentKey: "77777777-7777-4777-8777-777777777777",
      requirementKey: created.requirementKey,
      requirementRevision: 1,
      sequence: 6,
      occurredAt: "2026-08-13T04:00:05.000Z",
      event: {
        kind: "lifecycle",
        status: "failed",
        reason: "authentication",
      },
    });

    await expect(
      service.get(principal, created.requirementKey),
    ).resolves.toMatchObject({
      executionEvents: [
        {
          title: "Codex 开始分析需求",
          detail: "已进入受控项目工作区",
          occurredAt: "2026-08-13T04:00:00.000Z",
        },
        {
          title: "浏览项目结构",
          detail: "正在执行",
          occurredAt: "2026-08-13T04:00:00.500Z",
        },
        {
          title: "检索相关代码",
          detail: "已完成",
          occurredAt: "2026-08-13T04:00:01.000Z",
        },
        {
          title: "更新项目文件",
          detail: "src/App.tsx（更新）",
          occurredAt: "2026-08-13T04:00:02.000Z",
        },
        {
          title: "执行本地测试",
          detail: "未完成",
          occurredAt: "2026-08-13T04:00:03.000Z",
        },
        {
          title: "Codex 完成工作区修改",
          detail: "等待设备生成本地提交",
          occurredAt: "2026-08-13T04:00:04.000Z",
        },
        {
          title: "Codex 执行未完成",
          detail: "Codex 登录不可用，请在设备端重新完成登录",
          occurredAt: "2026-08-13T04:00:05.000Z",
        },
      ],
    });
    await expect(
      service.recordExecutionEvent(tenantKey, {
        eventKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        assignmentKey: "77777777-7777-4777-8777-777777777777",
        requirementKey: created.requirementKey,
        requirementRevision: 2,
        sequence: 7,
        occurredAt: "2026-08-13T04:00:06.000Z",
        event: { kind: "lifecycle", status: "completed" },
      }),
    ).rejects.toMatchObject({ code: "delivery_progress_stale" });
  });

  it("重复执行时只向页面返回最新一轮 Codex 过程记录", async () => {
    const repository = new InMemoryRequirementRepository();
    const service = new RequirementApplicationService({
      repository,
      projectKey,
      repositoryKey,
    });
    const created = await service.create(principal, spec);
    await service.submitForConfirmation(principal, created.requirementKey);
    await service.confirm(principal, created.requirementKey);
    await service.requestDelivery(principal, created.requirementKey, {
      schemaVersion: 1,
      requiredCapabilities: [],
    });

    const assignmentKey = "77777777-7777-4777-8777-777777777777";
    for (const event of [
      {
        eventKey: "11111111-aaaa-4111-8111-111111111111",
        occurredAt: "2026-08-13T04:00:00.000Z",
        event: { kind: "lifecycle", status: "started" } as const,
      },
      {
        eventKey: "22222222-aaaa-4222-8222-222222222222",
        occurredAt: "2026-08-13T04:00:10.000Z",
        event: {
          kind: "lifecycle",
          status: "failed",
          reason: "network",
        } as const,
      },
      {
        eventKey: "33333333-aaaa-4333-8333-333333333333",
        occurredAt: "2026-08-13T04:01:00.000Z",
        event: { kind: "lifecycle", status: "started" } as const,
      },
      {
        eventKey: "44444444-aaaa-4444-8444-444444444444",
        occurredAt: "2026-08-13T04:01:01.000Z",
        event: {
          kind: "tool",
          tool: "read_workspace_file",
          status: "completed",
        } as const,
      },
    ]) {
      await service.recordExecutionEvent(tenantKey, {
        ...event,
        assignmentKey,
        requirementKey: created.requirementKey,
        requirementRevision: 1,
        sequence: 1,
      });
    }

    const detail = await service.get(principal, created.requirementKey);

    expect(detail.executionEvents).toEqual([
      {
        title: "Codex 开始分析需求",
        detail: "已进入受控项目工作区",
        tone: "running",
        occurredAt: "2026-08-13T04:01:00.000Z",
      },
      {
        title: "读取项目文件",
        detail: "已完成",
        tone: "success",
        occurredAt: "2026-08-13T04:01:01.000Z",
      },
    ]);
  });

  it("新需求会持久化所属代码仓库，后续交付不会退回启动时的全局仓库", async () => {
    const repository = new InMemoryRequirementRepository();
    const service = new RequirementApplicationService({
      repository,
      projectKey,
      repositoryKey,
    });

    const created = await service.create(principal, spec);
    const stored = await repository.transaction(
      tenantKey,
      projectKey,
      (transaction) => transaction.find(created.requirementKey),
    );

    expect(stored).toMatchObject({ projectKey, repositoryKey });
  });

  it("强制终止交付会关闭待派发记录、留下审计并返回细粒度进度", async () => {
    const repository = new InMemoryRequirementRepository();
    const service = new RequirementApplicationService({
      repository,
      projectKey,
      repositoryKey,
      clock: () => new Date("2026-08-13T02:00:00.000Z"),
    });
    const created = await service.create(principal, spec);
    await service.submitForConfirmation(principal, created.requirementKey);
    await service.confirm(principal, created.requirementKey);
    await service.requestDelivery(principal, created.requirementKey, {
      schemaVersion: 1,
      requiredCapabilities: [],
    });
    const cancelAssignment = vi
      .fn()
      .mockRejectedValue(new Error("设备暂时离线"));

    await expect(
      service.terminateDelivery(
        principal,
        created.requirementKey,
        cancelAssignment,
      ),
    ).resolves.toMatchObject({
      view: { status: "已强制终止" },
      allowedActions: ["revise"],
    });
    expect(cancelAssignment).toHaveBeenCalledTimes(1);
    await expect(
      repository.listPendingDeliveryCancellations(tenantKey, 10),
    ).resolves.toHaveLength(1);
    await expect(
      repository.listPendingDeliveryDispatches(tenantKey, projectKey, 10),
    ).resolves.toEqual([]);
    await expect(
      service.get(principal, created.requirementKey),
    ).resolves.toMatchObject({
      progress: {
        percent: 35,
        currentStage: "交付已强制终止",
        stages: expect.arrayContaining([
          expect.objectContaining({
            key: "implementation",
            status: "terminated",
          }),
        ]),
      },
    });
    await expect(
      repository.listAuditEvents(tenantKey, projectKey),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "delivery.terminated" }),
      ]),
    );
  });

  it("需求分析师可修订完整规格并留下版本审计，研发不能修改", async () => {
    const repository = new InMemoryRequirementRepository();
    const service = new RequirementApplicationService({
      repository,
      projectKey,
      clock: () => new Date("2026-08-11T07:00:00.000Z"),
    });
    const created = await service.create(principal, spec);
    const analyst: AuthenticatedPrincipal = {
      ...principal,
      actorName: "需求分析师",
      roles: ["requirement_analyst"],
    };
    const revisedSpec = RequirementSpecSchema.parse({
      ...spec,
      goal: "让访客预约后由业主确认到访时间",
      openQuestions: ["访客改期是否需要重新确认"],
    });

    await expect(
      service.revise(
        { ...principal, roles: ["developer"] },
        created.requirementKey,
        1,
        revisedSpec,
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "permission_denied" });
    await expect(
      service.revise(analyst, created.requirementKey, 1, revisedSpec),
    ).resolves.toMatchObject({
      view: {
        version: "第 2 版",
        status: "内容已更新，等待重新确认",
      },
    });

    const detail = await service.get(principal, created.requirementKey);
    expect(detail.spec).toEqual(revisedSpec);
    expect(detail.revisions).toEqual([
      expect.objectContaining({ version: "第 1 版", current: false }),
      expect.objectContaining({
        version: "第 2 版",
        current: true,
        changedBy: "需求分析师",
        changes: ["业务目标", "待澄清问题"],
      }),
    ]);
    expect(await repository.listAuditEvents(tenantKey, projectKey)).toEqual([
      expect.objectContaining({ action: "requirement.created" }),
      expect.objectContaining({
        action: "requirement.revised",
        actorName: "需求分析师",
      }),
    ]);
  });

  it("用预期版本阻止两个分析师互相覆盖完整规格", async () => {
    const repository = new InMemoryRequirementRepository();
    const service = new RequirementApplicationService({
      repository,
      projectKey,
    });
    const created = await service.create(principal, spec);
    const analyst: AuthenticatedPrincipal = {
      ...principal,
      roles: ["requirement_analyst"],
    };

    await service.revise(analyst, created.requirementKey, 1, {
      ...spec,
      goal: "分析师 A 已补充业主确认流程",
    });
    await expect(
      service.revise(analyst, created.requirementKey, 1, {
        ...spec,
        goal: "分析师 B 仍基于第一版编辑",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "requirement_revision_conflict",
    });
    await expect(
      service.get(principal, created.requirementKey),
    ).resolves.toMatchObject({
      spec: { goal: "分析师 A 已补充业主确认流程" },
      view: { version: "第 2 版" },
    });
  });

  it("读取旧工作流快照时仍返回数据库行中的完整当前规格", async () => {
    const repository = new InMemoryRequirementRepository();
    const complete = RequirementWorkflow.createFromSpec(spec, {
      tenantKey,
      projectKey,
    });
    const snapshot = complete.toSnapshot();
    const legacy = RequirementWorkflow.fromSnapshot({
      ...snapshot,
      schemaVersion: 1,
      revisions: snapshot.revisions.map(
        ({ spec: _spec, contentState: _contentState, ...revision }) => ({
          ...revision,
          specHash: null,
        }),
      ),
    });
    await repository.transaction(tenantKey, projectKey, async (transaction) => {
      transaction.save({
        tenantKey,
        projectKey,
        requirementKey: legacy.internalKey,
        createdAt: "2026-08-11T07:00:00.000Z",
        spec,
        workflow: legacy,
      });
    });
    const service = new RequirementApplicationService({
      repository,
      projectKey,
    });

    await expect(
      service.get(principal, legacy.internalKey),
    ).resolves.toMatchObject({
      spec,
      revisions: [expect.objectContaining({ contentState: "完整规格", spec })],
    });
  });

  it("只从已验证的工作流读取 Preview 制品引用，并允许项目成员查看", async () => {
    const repository = new InMemoryRequirementRepository();
    const service = new RequirementApplicationService({
      repository,
      projectKey,
    });
    const created = await service.create(principal, spec);
    const reference = {
      requirementRevision: 1,
      artifactHashAlgorithm: "sha256" as const,
      artifactHash: "a".repeat(64),
    };
    const readReference = vi
      .spyOn(RequirementWorkflow.prototype, "toPreviewArtifactReference")
      .mockReturnValueOnce(reference);

    await expect(
      service.getPreviewTarget(
        { ...principal, roles: ["developer"] },
        created.requirementKey,
      ),
    ).resolves.toEqual({
      tenantKey,
      projectKey,
      requirementKey: created.requirementKey,
      ...reference,
    });
    expect(readReference).toHaveBeenCalledOnce();
  });

  it("没有可信验收证据时不提供 Preview 制品", async () => {
    const repository = new InMemoryRequirementRepository();
    const service = new RequirementApplicationService({
      repository,
      projectKey,
    });
    const created = await service.create(principal, spec);

    await expect(
      service.getPreviewTarget(principal, created.requirementKey),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "preview_not_ready",
    });
  });

  it("产品验收使用认证身份写入审计，分析师不能代替验收", async () => {
    const repository = new InMemoryRequirementRepository();
    const service = new RequirementApplicationService({
      repository,
      projectKey,
      clock: () => new Date("2026-08-10T03:00:00.000Z"),
    });
    const created = await service.create(principal, spec);
    const analyst: AuthenticatedPrincipal = {
      ...principal,
      actorKey: "77777777-7777-4777-8777-777777777777",
      actorName: "需求分析师",
      roles: ["requirement_analyst"],
    };

    await expect(
      service.accept(analyst, created.requirementKey),
    ).rejects.toMatchObject({ statusCode: 403, code: "permission_denied" });

    const accept = vi
      .spyOn(RequirementWorkflow.prototype, "accept")
      .mockImplementationOnce(() => undefined);
    await service.accept(principal, created.requirementKey);

    expect(accept).toHaveBeenCalledWith({
      actor: {
        actorKey: principal.actorKey,
        actorName: "产品负责人",
      },
    });
    expect(await repository.listAuditEvents(tenantKey, projectKey)).toEqual([
      expect.objectContaining({ action: "requirement.created" }),
      expect.objectContaining({
        action: "requirement.accepted",
        actorKey: principal.actorKey,
        actorName: "产品负责人",
      }),
    ]);
  });

  it("审计写入失败时回滚需求状态，下一次操作仍可正常执行", async () => {
    const repository = new InMemoryRequirementRepository();
    let clockValue = new Date("2026-08-10T03:00:00.000Z");
    const service = new RequirementApplicationService({
      repository,
      projectKey,
      clock: () => new Date(clockValue.getTime()),
    });
    const created = await service.create(principal, spec);
    clockValue = new Date("invalid");

    await expect(
      service.submitForConfirmation(principal, created.requirementKey),
    ).rejects.toThrow("服务端时间无效");

    clockValue = new Date("2026-08-10T03:05:00.000Z");
    await expect(
      service.submitForConfirmation(principal, created.requirementKey),
    ).resolves.toMatchObject({
      view: { status: "等待负责人确认" },
    });
    expect(
      await repository.listAuditEvents(tenantKey, projectKey),
    ).toHaveLength(2);
  });

  it("并发重复命令只提交一次状态和审计", async () => {
    const repository = new InMemoryRequirementRepository();
    const service = new RequirementApplicationService({
      repository,
      projectKey,
      clock: () => new Date("2026-08-10T03:00:00.000Z"),
    });
    const created = await service.create(principal, spec);

    const results = await Promise.allSettled([
      service.submitForConfirmation(principal, created.requirementKey),
      service.submitForConfirmation(principal, created.requirementKey),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      await repository.listAuditEvents(tenantKey, projectKey),
    ).toHaveLength(2);
  });

  it("事务返回的聚合引用不能在提交后绕过仓储和审计继续修改", async () => {
    const repository = new InMemoryRequirementRepository();
    const service = new RequirementApplicationService({
      repository,
      projectKey,
      clock: () => new Date("2026-08-10T03:00:00.000Z"),
    });
    const created = await service.create(principal, spec);
    const escaped = await repository.transaction(
      tenantKey,
      projectKey,
      (transaction) => transaction.find(created.requirementKey),
    );

    escaped!.workflow.submitForConfirmation();

    expect((await service.list(principal)).items).toEqual([
      expect.objectContaining({
        view: expect.objectContaining({ status: "正在整理" }),
      }),
    ]);
    expect(
      await repository.listAuditEvents(tenantKey, projectKey),
    ).toHaveLength(1);
  });

  it("同一租户的不同项目分别隔离需求列表和审计事件", async () => {
    const repository = new InMemoryRequirementRepository();
    const otherProjectKey = "77777777-7777-4777-8777-777777777777";
    const serviceA = new RequirementApplicationService({
      repository,
      projectKey,
    });
    const serviceB = new RequirementApplicationService({
      repository,
      projectKey: otherProjectKey,
    });
    await serviceA.create(principal, spec);
    await serviceB.create(principal, { ...spec, title: "工单审批" });

    expect((await serviceA.list(principal)).items).toEqual([
      expect.objectContaining({
        view: expect.objectContaining({ title: "访客预约" }),
      }),
    ]);
    expect((await serviceB.list(principal)).items).toEqual([
      expect.objectContaining({
        view: expect.objectContaining({ title: "工单审批" }),
      }),
    ]);
    expect(
      await repository.listAuditEvents(tenantKey, projectKey),
    ).toHaveLength(1);
    expect(
      await repository.listAuditEvents(tenantKey, otherProjectKey),
    ).toHaveLength(1);
  });

  it("创建后可以从持久态完整还原用户故事、问题和验收说明", async () => {
    const repository = new InMemoryRequirementRepository();
    const service = new RequirementApplicationService({
      repository,
      projectKey,
    });
    const created = await service.create(principal, spec);

    const detail = await service.get(principal, created.requirementKey);

    expect(detail.spec).toEqual(spec);
  });

  it("游标按仓储单调位置翻页，并发新增不会因随机 UUID 排序而漏项", async () => {
    const repository = new InMemoryRequirementRepository();
    const createRecord = (title: string): RequirementRecord => {
      const recordSpec = { ...spec, title };
      const workflow = RequirementWorkflow.createFromSpec(recordSpec, {
        tenantKey,
        projectKey,
      });
      return {
        tenantKey,
        projectKey,
        requirementKey: workflow.internalKey,
        createdAt: "2026-08-10T03:00:00.000Z",
        spec: recordSpec,
        workflow,
      };
    };
    let first = createRecord("第一项需求");
    let second = createRecord("第二项需求");
    while (first.requirementKey < second.requirementKey) {
      first = createRecord("第一项需求");
      second = createRecord("第二项需求");
    }
    const concurrent = createRecord("并发新增需求");
    await repository.transaction(tenantKey, projectKey, (transaction) => {
      transaction.save(first);
      transaction.save(second);
    });

    const firstPage = await repository.listForPeople(tenantKey, projectKey, {
      limit: 1,
    });
    await repository.transaction(tenantKey, projectKey, (transaction) => {
      transaction.save(concurrent);
    });
    const secondPage = await repository.listForPeople(tenantKey, projectKey, {
      limit: 1,
      afterPosition: firstPage.nextPosition!,
    });
    const thirdPage = await repository.listForPeople(tenantKey, projectKey, {
      limit: 1,
      afterPosition: secondPage.nextPosition!,
    });

    expect(
      [...firstPage.items, ...secondPage.items, ...thirdPage.items].map(
        (item) => item.requirementKey,
      ),
    ).toEqual([
      first.requirementKey,
      second.requirementKey,
      concurrent.requirementKey,
    ]);
  });

  it("仓储事务自身拒绝写入其他项目的需求和审计", async () => {
    const repository = new InMemoryRequirementRepository();
    const otherProjectKey = "77777777-7777-4777-8777-777777777777";
    const foreignRecord: RequirementRecord = {
      tenantKey,
      projectKey: otherProjectKey,
      requirementKey: "99999999-9999-4999-8999-999999999999",
      createdAt: "2026-08-10T03:00:00.000Z",
      spec,
      workflow: RequirementWorkflow.create(
        {
          title: spec.title,
          summary: spec.goal,
          acceptanceCriteria: spec.acceptanceCriteria.map((item) => item.title),
        },
        { tenantKey, projectKey: otherProjectKey },
      ),
    };

    await expect(
      repository.transaction(tenantKey, projectKey, (transaction) =>
        transaction.save(foreignRecord),
      ),
    ).rejects.toThrow("其他项目");
    await expect(
      repository.transaction(tenantKey, projectKey, (transaction) =>
        transaction.appendAudit({
          eventKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          tenantKey,
          projectKey: otherProjectKey,
          requirementKey: foreignRecord.requirementKey,
          action: "requirement.created",
          actorKey: principal.actorKey,
          actorName: principal.actorName,
          recordedAt: "2026-08-10T03:00:00.000Z",
        }),
      ),
    ).rejects.toThrow("其他项目");
  });

  it("仓储拒绝用外层记录伪装领域聚合的项目范围或需求身份", async () => {
    const repository = new InMemoryRequirementRepository();
    const otherProjectKey = "77777777-7777-4777-8777-777777777777";
    const foreignWorkflow = RequirementWorkflow.create(
      {
        title: spec.title,
        summary: spec.goal,
        acceptanceCriteria: spec.acceptanceCriteria.map((item) => item.title),
      },
      { tenantKey, projectKey: otherProjectKey },
    );
    const disguisedScope: RequirementRecord = {
      tenantKey,
      projectKey,
      requirementKey: foreignWorkflow.internalKey,
      createdAt: "2026-08-10T03:00:00.000Z",
      spec,
      workflow: foreignWorkflow,
    };

    await expect(
      repository.transaction(tenantKey, projectKey, (transaction) =>
        transaction.save(disguisedScope),
      ),
    ).rejects.toThrow("聚合身份与持久化范围不一致");

    const localWorkflow = RequirementWorkflow.create(
      {
        title: spec.title,
        summary: spec.goal,
        acceptanceCriteria: spec.acceptanceCriteria.map((item) => item.title),
      },
      { tenantKey, projectKey },
    );
    await expect(
      repository.transaction(tenantKey, projectKey, (transaction) =>
        transaction.save({
          ...disguisedScope,
          projectKey,
          requirementKey: "99999999-9999-4999-8999-999999999999",
          workflow: localWorkflow,
        }),
      ),
    ).rejects.toThrow("聚合身份与持久化范围不一致");
  });

  it("仓储拒绝需求规格与已确认工作流不是同一份业务内容", async () => {
    const repository = new InMemoryRequirementRepository();
    const workflow = RequirementWorkflow.createFromSpec(spec, {
      tenantKey,
      projectKey,
    });

    await expect(
      repository.transaction(tenantKey, projectKey, (transaction) =>
        transaction.save({
          tenantKey,
          projectKey,
          requirementKey: workflow.internalKey,
          createdAt: "2026-08-10T03:00:00.000Z",
          spec: { ...spec, openQuestions: ["是否需要短信通知"] },
          workflow,
        }),
      ),
    ).rejects.toThrow("需求规格与工作流业务内容不一致");
  });
});
