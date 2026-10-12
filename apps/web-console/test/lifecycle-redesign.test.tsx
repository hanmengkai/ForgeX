// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, it, expect, vi } from "vitest";
import type { LifecycleView } from "@forgex/contracts/lifecycle";
import type { ForgeXClient } from "../src/api.js";
import { LifecycleWorkbench } from "../src/lifecycle-workbench.js";
import { DashboardOverview } from "../src/dashboard-overview.js";
const key = "11111111-1111-4111-8111-111111111111";
const initial = (): LifecycleView => ({
  schemaVersion: 2,
  workflowKey: key,
  projectKey: key,
  repositoryKey: key,
  requesterKey: key,
  title: "访客预约",
  brief: "提交预约并获取编号",
  version: 4,
  requirementVersion: 1,
  designVersion: 2,
  stage: "design_review",
  stageLabel: "独立设计审核",
  blockedReason: null,
  updatedAt: "2026-10-12T04:00:00.000Z",
  sourceBugKey: null,
  approvals: [],
  objections: [],
  artifacts: [
    {
      kind: "design",
      summary: "预约接口与幂等处理方案",
      content: "架构说明\n\n接口：\nPOST /appointments",
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
const setup = () => {
  let current = initial();
  const api = {
    context: vi.fn(async () => ({
      schemaVersion: 2,
      actorKey: key,
      actorName: "研发负责人",
      projectKey: key,
      repositoryKey: key,
      roles: ["developer"],
    })),
    list: vi.fn(async () => [
      current,
      {
        ...initial(),
        workflowKey: "22222222-2222-4222-8222-222222222222",
        title: "客服查询",
        stage: "closed",
        stageLabel: "已关闭",
        allowedRoles: [],
      },
    ]),
    get: vi.fn(async () => current),
    bugs: vi.fn(async () => []),
    notifications: vi.fn(async () => []),
    decide: vi.fn(async () => current),
    action: vi.fn(async () => current),
    readNotification: vi.fn(),
  };
  return {
    client: { lifecycle: api } as unknown as ForgeXClient,
    api,
    update: (next: LifecycleView) => {
      current = next;
    },
  };
};
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/delivery");
});
describe("2.0 交付界面主线", () => {
  it("六段流程保留独立设计审核，审批位于成果之前，搜索和类别筛选可定位需求", async () => {
    const { client } = setup();
    render(<LifecycleWorkbench client={client} />);
    const phases = await screen.findByRole("list", { name: "交付阶段" });
    expect(within(phases).getAllByRole("listitem")).toHaveLength(6);
    expect(
      screen.getByText("下一步：由研发负责人独立审核设计方案"),
    ).toBeInTheDocument();
    const approval = screen.getByRole("region", { name: "当前审核" }),
      materials = screen.getByRole("region", { name: "当前审核材料" });
    expect(
      approval.compareDocumentPosition(materials) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await userEvent.type(
      screen.getByRole("searchbox", { name: "搜索交付需求" }),
      "客服",
    );
    expect(
      within(screen.getByRole("region", { name: "交付列表" })).queryByText(
        "访客预约",
      ),
    ).toBeNull();
    await userEvent.clear(
      screen.getByRole("searchbox", { name: "搜索交付需求" }),
    );
    await userEvent.click(screen.getByRole("button", { name: /待我处理/ }));
    expect(
      within(screen.getByRole("region", { name: "交付列表" })).queryByText(
        "客服查询",
      ),
    ).toBeNull();
  });
  it("审批取消不写入，确认绑定原设计版本，刷新变更后禁止提交旧审核", async () => {
    const { client, api, update } = setup();
    render(<LifecycleWorkbench client={client} />);
    await userEvent.type(
      await screen.findByLabelText("审核意见或处理结论"),
      "设计已核对",
    );
    await userEvent.click(screen.getByRole("button", { name: "审核通过" }));
    expect(
      await screen.findByRole("dialog", { name: "确认审核通过" }),
    ).toHaveTextContent("设计第 2 版");
    await userEvent.click(screen.getByRole("button", { name: "继续核对" }));
    expect(api.decide).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "审核通过" }));
    update({ ...initial(), version: 5, designVersion: 3 });
    await userEvent.click(screen.getByRole("button", { name: "刷新进度" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.decide).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("内容已更新");
  });
  it("首页使用完整交付待办，打开对应需求且不会把读取失败当作运行正常", async () => {
    const { client } = setup(),
      navigate = vi.fn();
    render(
      <DashboardOverview
        client={client}
        projectName="访客平台"
        onNavigate={navigate}
      />,
    );
    await screen.findByRole("heading", { name: "我的待办" });
    await userEvent.click(
      await screen.findByRole("button", { name: /审核设计.*访客预约/ }),
    );
    expect(navigate).toHaveBeenCalledWith(`/delivery?workflow=${key}`);
    expect(screen.queryByText("平台运行正常")).toBeNull();
  });
});
