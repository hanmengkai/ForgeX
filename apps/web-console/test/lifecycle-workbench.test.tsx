// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LifecycleBug,
  LifecycleContext,
  LifecycleView,
} from "@forgex/contracts/lifecycle";
import type { ForgeXClient } from "../src/api.js";
import type { LifecycleClient } from "../src/lifecycle-client.js";
import { LifecycleWorkbench } from "../src/lifecycle-workbench.js";
import { RequirementWorkbench } from "../src/requirement-workbench.js";

const key = "11111111-1111-4111-8111-111111111111";
const context: LifecycleContext = {
  schemaVersion: 2,
  projectKey: key,
  repositoryKey: key,
  actorKey: key,
  actorName: "需求方",
  roles: ["requester"],
};
const initial = (): LifecycleView => ({
  schemaVersion: 2,
  workflowKey: key,
  projectKey: key,
  repositoryKey: key,
  requesterKey: key,
  title: "访客预约",
  brief: "提交预约获得可查询编号",
  version: 3,
  requirementVersion: 1,
  designVersion: 1,
  stage: "design_review",
  stageLabel: "独立设计审核",
  blockedReason: null,
  updatedAt: "2026-10-10T10:00:00.000Z",
  sourceBugKey: null,
  approvals: [],
  objections: [],
  artifacts: [
    {
      kind: "design",
      summary: "预约 API 与幂等策略设计",
      content: "需要产品确认的预约接口与数据持久化策略",
      url: null,
      checks: [],
      technical: null,
    },
  ],
  events: [],
  currentJob: null,
  allowedRoles: ["developer"],
  allowedActions: [],
  canReportBug: false,
});
const fixture = (
  flow: LifecycleView | null = initial(),
  roles: LifecycleContext["roles"] = ["developer"],
) => {
  let current = flow;
  const api: LifecycleClient = {
    context: vi.fn(async () => ({ ...context, roles })),
    list: vi.fn(async () => (current ? [current] : [])),
    get: vi.fn(async () => current!),
    create: vi.fn(async () => {
      current = initial();
      return current;
    }),
    decide: vi.fn(async () => {
      throw new Error("交付内容已经更新，请刷新后审核当前版本");
    }),
    action: vi.fn(async () => current!),
    bugs: vi.fn(async () => []),
    reportBug: vi.fn(),
    repairBug: vi.fn(),
    notifications: vi.fn(async () => []),
    readNotification: vi.fn(async () => {}),
  };
  const client = {
    lifecycle: api,
    listRequirementContexts: vi.fn(async () => ({ customers: [] })),
    listWorkers: vi.fn(),
  } as unknown as ForgeXClient;
  return {
    api,
    client,
    update: (value: LifecycleView) => {
      current = value;
    },
  };
};
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("完整交付控制台", () => {
  it("需求方默认进入自己的交付入口，不请求内部目录，提交后展示当前方案", async () => {
    const { api, client } = fixture(null, ["requester"]);
    render(<RequirementWorkbench client={client} roles={["requester"]} />);
    await screen.findByRole("heading", { name: "提出需求" });
    expect(window.location.pathname).toBe("/delivery");
    expect(client.listRequirementContexts).not.toHaveBeenCalled();
    expect(client.listWorkers).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "执行器管理" })).toBeNull();
    await userEvent.type(screen.getByLabelText("需求名称"), "访客预约");
    await userEvent.type(
      screen.getByLabelText("业务目标与已有信息"),
      "提交预约并获取可查询编号",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "提交给需求 AI" }),
    );
    await screen.findByText("预约 API 与幂等策略设计");
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "访客预约",
        brief: "提交预约并获取可查询编号",
      }),
    );
    expect(screen.queryByLabelText("需求名称")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "＋ 提出需求" }));
    expect(screen.getByLabelText("需求名称")).toHaveValue("");
  });
  it("有异议时禁用通过，记录处理结论；过期审批显示错误且不重复提交", async () => {
    const flow = initial();
    flow.objections = [
      {
        objectionKey: key,
        stage: "design_review",
        round: 1,
        actorKey: key,
        actorName: "研发",
        reason: "缺少重复请求策略",
        resolution: null,
        resolvedBy: null,
      },
    ];
    flow.allowedActions = ["resolve_objection"];
    const { api, client, update } = fixture(flow);
    vi.mocked(api.action).mockImplementation(async () => {
      const next = {
        ...flow,
        objections: flow.objections.map((o) => ({
          ...o,
          resolution: "已确认幂等策略",
          resolvedBy: key,
        })),
        allowedActions: [],
      };
      update(next);
      return next;
    });
    render(<LifecycleWorkbench client={client} />);
    const reason = await screen.findByLabelText("审核意见或处理结论");
    await userEvent.type(reason, "已确认幂等策略");
    expect(screen.getByRole("button", { name: "审核通过" })).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "按填写结论处理异议" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "审核通过" })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "审核通过" }));
    await userEvent.click(screen.getByRole("button", { name: "确认提交" }));
    await screen.findByRole("alert");
    expect(api.decide).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("交付内容已经更新");
    expect(api.action).toHaveBeenCalledWith(flow, {
      action: "resolve_objection",
      reason: "已确认幂等策略",
      objectionKey: key,
    });
  });
  it("关闭后可报告 Bug、安排修复并查看关联交付，修复确认失败保留业务提示", async () => {
    const flow = {
      ...initial(),
      stage: "closed" as const,
      stageLabel: "已关闭",
      allowedRoles: [],
      canReportBug: true,
    };
    const { api, client, update } = fixture(flow, ["developer", "tester"]);
    let bug: LifecycleBug | null = null;
    vi.mocked(api.bugs).mockImplementation(async () => (bug ? [bug] : []));
    vi.mocked(api.reportBug).mockImplementation(async (_key, input) => {
      bug = {
        schemaVersion: 2,
        bugKey: key,
        tenantKey: key,
        projectKey: key,
        workflowKey: key,
        reportedBy: key,
        ...input,
        status: "open",
        repairWorkflowKey: null,
        createdAt: "2026-10-10T10:00:00.000Z",
        resolvedAt: null,
      };
      return bug;
    });
    vi.mocked(api.repairBug).mockImplementation(async (_key, action) => {
      if (action === "resolve") throw new Error("关联修复需求尚未完成线上验收");
      bug = { ...bug!, status: "repairing", repairWorkflowKey: key };
      return bug;
    });
    render(<LifecycleWorkbench client={client} />);
    await userEvent.click(await screen.findByRole("tab", { name: "关联 Bug" }));
    await userEvent.type(
      await screen.findByLabelText("问题名称"),
      "预约缺少确认说明",
    );
    await userEvent.type(
      screen.getByLabelText("复现步骤与预期结果"),
      "提交成功后应显示预约确认结果",
    );
    await userEvent.click(screen.getByRole("button", { name: "提交 Bug" }));
    await screen.findByText("待安排修复");
    await userEvent.click(screen.getByRole("button", { name: "创建修复需求" }));
    await screen.findByText("修复处理中");
    await userEvent.click(screen.getByRole("button", { name: "确认修复完成" }));
    await screen.findByText("关联修复需求尚未完成线上验收");
    update({ ...flow, title: "修复预约说明", sourceBugKey: key });
    await userEvent.click(screen.getByRole("button", { name: "查看修复交付" }));
    await userEvent.click(screen.getByRole("button", { name: "刷新进度" }));
    await screen.findByText("这是关联缺陷的修复需求。");
    expect(api.reportBug).toHaveBeenCalledTimes(1);
    expect(api.repairBug).toHaveBeenCalledWith(key, "start_repair");
  });
});
