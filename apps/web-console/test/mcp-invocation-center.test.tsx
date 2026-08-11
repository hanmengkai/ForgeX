// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  McpInvocationCenter,
  type ForgeXClient,
  type McpInvocationListItem,
} from "../src/index.js";

const pending: McpInvocationListItem = {
  title: "创建交付分支",
  serviceName: "代码仓库助手",
  status: "等待产品确认",
  requestedBy: "初级研发",
  requestedAt: "2026-08-10T10:00:00.000Z",
  detail: "涉及写入或外部动作，需要产品负责人确认",
  inputs: [
    {
      label: "分支名称",
      display: "single",
      values: ["feature/payment"],
      sensitive: false,
    },
    {
      label: "访问凭据",
      display: "masked",
      values: ["已安全提供"],
      sensitive: true,
    },
  ],
  links: {
    self: "/api/v1/mcp-invocations/33333333-3333-4333-8333-333333333333",
    actions: {
      approve:
        "/api/v1/mcp-invocations/33333333-3333-4333-8333-333333333333/approve",
      cancel:
        "/api/v1/mcp-invocations/33333333-3333-4333-8333-333333333333/cancel",
    },
  },
};
const queued: McpInvocationListItem = {
  ...pending,
  title: "读取项目结构",
  status: "等待设备执行",
  requestedAt: "2026-08-10T09:59:00.000Z",
  detail: "只读操作，已通过安全规则自动确认",
  links: {
    self: "/api/v1/mcp-invocations/44444444-4444-4444-8444-444444444444",
    actions: {},
  },
};

const createClient = (): ForgeXClient => ({
  startSession: vi.fn(),
  getSession: vi.fn(),
  endSession: vi.fn(),
  listAccounts: vi.fn().mockResolvedValue([]),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  deleteAccount: vi.fn(),
  listPlatformConfiguration: vi.fn().mockResolvedValue({ customers: [] }),
  createPlatformCustomer: vi.fn(),
  updatePlatformCustomer: vi.fn(),
  deletePlatformCustomer: vi.fn(),
  createPlatformProject: vi.fn(),
  updatePlatformProject: vi.fn(),
  deletePlatformProject: vi.fn(),
  createProjectRepository: vi.fn(),
  updateProjectRepository: vi.fn(),
  deleteProjectRepository: vi.fn(),
  listRequirements: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  listWorkers: vi.fn().mockResolvedValue({
    workers: [],
    capacity: { connectedAccounts: 0, unlimited: true },
  }),
  connectWorker: vi.fn(),
  listExtensions: vi.fn().mockResolvedValue({
    businessKnowledge: [],
    teamCapabilities: [],
    externalTools: [],
  }),
  getMcpToolCatalog: vi.fn(),
  getMcpInvocationForm: vi.fn(),
  requestMcpInvocation: vi.fn(),
  listMcpInvocations: vi.fn().mockResolvedValue([pending, queued]),
  getKnowledgeBase: vi.fn(),
  createKnowledgeBase: vi.fn(),
  publishKnowledgeSource: vi.fn(),
  archiveKnowledgeSource: vi.fn(),
  searchKnowledgeBase: vi.fn(),
  getRequirement: vi.fn(),
  createRequirement: vi.fn(),
  reviseRequirement: vi.fn(),
  runRequirementAction: vi.fn(),
  approveMcpInvocation: vi.fn().mockResolvedValue(undefined),
  cancelMcpInvocation: vi.fn().mockResolvedValue(undefined),
});

afterEach(cleanup);

describe("McpInvocationCenter", () => {
  it("用业务名称展示待确认与排队操作，不显示内部标识和技术工具名", async () => {
    render(<McpInvocationCenter client={createClient()} />);

    expect(await screen.findByText("创建交付分支")).toBeInTheDocument();
    expect(screen.getByText("读取项目结构")).toBeInTheDocument();
    expect(screen.getAllByText("代码仓库助手")).toHaveLength(2);
    expect(screen.getAllByText("初级研发发起")).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(
      /repository\.|serverKey|toolKey|[0-9a-f]{8}-[0-9a-f]{4}-/i,
    );
  });

  it("只显示服务端授权的确认按钮，确认期间锁定所有操作并完成后刷新", async () => {
    const user = userEvent.setup();
    const client = createClient();
    let resolve!: () => void;
    vi.mocked(client.approveMcpInvocation).mockReturnValue(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    render(<McpInvocationCenter client={client} />);

    const approve = await screen.findByRole("button", {
      name: "确认创建交付分支并交给设备执行",
    });
    await user.click(approve);
    expect(approve).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "不执行这项操作" }),
    ).toBeDisabled();
    expect(client.approveMcpInvocation).toHaveBeenCalledWith(
      pending.links.actions.approve,
    );
    expect(screen.queryByRole("button", { name: /读取项目结构/ })).toBeNull();

    resolve();
    await waitFor(() =>
      expect(client.listMcpInvocations).toHaveBeenCalledTimes(2),
    );
  });

  it("发起人可以从业务卡片取消操作，页面不要求填写内部标识", async () => {
    const user = userEvent.setup();
    const client = createClient();
    render(<McpInvocationCenter client={client} />);

    await user.click(
      await screen.findByRole("button", { name: "不执行这项操作" }),
    );
    expect(client.cancelMcpInvocation).toHaveBeenCalledWith(
      pending.links.actions.cancel,
    );
    await waitFor(() =>
      expect(client.listMcpInvocations).toHaveBeenCalledTimes(2),
    );
  });
});
