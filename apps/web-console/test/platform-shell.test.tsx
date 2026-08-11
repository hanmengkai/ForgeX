// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RequirementWorkbench, type ForgeXClient } from "../src/index.js";

const createClient = (): ForgeXClient =>
  ({
    startSession: vi.fn(),
    getSession: vi.fn(),
    endSession: vi.fn(),
    listRequirementContexts: vi.fn().mockResolvedValue({ customers: [] }),
    listRequirements: vi.fn().mockResolvedValue({
      items: [
        {
          title: "访客预约",
          summary: "让访客到访过程更顺畅",
          version: "第 1 版",
          status: "AI 正在实现",
          nextStep: "等待独立验证完成",
          acceptanceProgress: "验证准备中",
          links: {
            self: "/api/v1/requirements/33333333-3333-4333-8333-333333333333",
            history:
              "/api/v1/requirements/33333333-3333-4333-8333-333333333333/revisions",
            actions: {},
          },
        },
      ],
      nextCursor: null,
    }),
    listWorkers: vi.fn().mockResolvedValue({
      workers: [
        {
          deviceName: "研发电脑 1",
          accountName: "Codex 账户 1",
          status: "空闲",
          currentWork: null,
        },
      ],
      capacity: {
        connectedAccounts: 1,
        unlimited: true,
      },
      connectAction: "/api/v1/worker-enrollments",
    }),
    listExtensions: vi.fn().mockResolvedValue({
      businessKnowledge: [],
      teamCapabilities: [],
      externalTools: [],
    }),
    listAccounts: vi.fn().mockResolvedValue([
      {
        username: "super.admin",
        actorName: "超级管理员",
        roles: ["administrator"],
        enabled: true,
        links: {
          self: "/api/v1/accounts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      },
    ]),
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
    connectWorker: vi.fn(),
    getMcpToolCatalog: vi.fn(),
    getMcpInvocationForm: vi.fn(),
    requestMcpInvocation: vi.fn(),
    listMcpInvocations: vi.fn().mockResolvedValue([]),
    getKnowledgeBase: vi.fn(),
    createKnowledgeBase: vi.fn(),
    publishKnowledgeSource: vi.fn(),
    archiveKnowledgeSource: vi.fn(),
    searchKnowledgeBase: vi.fn(),
    getRequirement: vi.fn(),
    createRequirement: vi.fn(),
    reviseRequirement: vi.fn(),
    runRequirementAction: vi.fn(),
    approveMcpInvocation: vi.fn(),
    cancelMcpInvocation: vi.fn(),
  }) as ForgeXClient;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = "";
  window.history.replaceState(null, "", "/");
});

describe("ForgeX 控制台框架", () => {
  it("默认使用浅色主题，并允许用户切换后在刷新时保留深色选择", async () => {
    const firstView = render(
      <RequirementWorkbench
        client={createClient()}
        actorName="超级管理员"
        actorUsername="super.admin"
        roles={["administrator"]}
      />,
    );

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    const themeToggle = screen.getByRole("button", {
      name: "切换为深色主题",
    });
    expect(themeToggle).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(themeToggle);
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(window.localStorage.getItem("forgex-color-theme")).toBe("dark");
    expect(
      screen.getByRole("button", { name: "切换为浅色主题" }),
    ).toHaveAttribute("aria-pressed", "true");

    firstView.unmount();
    delete document.documentElement.dataset.theme;
    document.documentElement.style.colorScheme = "";

    render(
      <RequirementWorkbench
        client={createClient()}
        actorName="超级管理员"
        actorUsername="super.admin"
        roles={["administrator"]}
      />,
    );

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(
      screen.getByRole("button", { name: "切换为浅色主题" }),
    ).toBeInTheDocument();
  });

  it("工作台展示有图标的运行概况、基础信息和顶部账号状态", async () => {
    const client = createClient();
    render(
      <RequirementWorkbench
        client={client}
        projectName="访客预约平台"
        actorName="超级管理员"
        actorUsername="super.admin"
        roles={["administrator"]}
        onSignOut={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "ForgeX 运行总览" }),
    ).toBeInTheDocument();
    expect(screen.getByText("访客预约平台")).toBeInTheDocument();
    expect(screen.getByText("1 个 / 不限数量")).toBeInTheDocument();
    expect(screen.getByText("平台运行正常")).toBeInTheDocument();
    expect(screen.getByText("super.admin")).toBeInTheDocument();
    expect(
      screen.getByText("super.admin").closest(".workspace-identity"),
    ).toBeInTheDocument();
    expect(screen.getByText("超级管理员")).toBeInTheDocument();
    expect(
      document.querySelectorAll(".dashboard-card .icon").length,
    ).toBeGreaterThan(2);
  });

  it("菜单按业务和平台分组，并将前进后退与地址栏同步", async () => {
    render(
      <RequirementWorkbench
        client={createClient()}
        actorName="超级管理员"
        actorUsername="super.admin"
        roles={["administrator"]}
      />,
    );

    expect(await screen.findByText("业务工作")).toBeInTheDocument();
    expect(screen.getByText("平台管理")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "需求管理" }));
    expect(window.location.pathname).toBe("/requirements");
    expect(screen.getByRole("link", { name: "需求管理" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await userEvent.click(screen.getByRole("link", { name: "设备与 Agent" }));
    expect(window.location.pathname).toBe("/agents");
    expect(await screen.findByText("安装 ForgeX Agent")).toBeInTheDocument();

    window.history.back();
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(window.location.pathname).toBe("/requirements"));
    expect(screen.getByRole("link", { name: "需求管理" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("超级管理员可进入账号管理并看到完整 CRUD 入口", async () => {
    const client = createClient();
    render(
      <RequirementWorkbench
        client={client}
        actorName="超级管理员"
        actorUsername="super.admin"
        roles={["administrator"]}
      />,
    );

    await userEvent.click(screen.getByRole("link", { name: "账号管理" }));
    expect(window.location.pathname).toBe("/platform/accounts");
    expect(
      (await screen.findAllByText("super.admin")).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByRole("button", { name: "新建账号" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "新建账号" }));
    expect(screen.getByLabelText("初始密码")).toHaveAttribute(
      "minlength",
      "6",
    );
    expect(
      screen.getByRole("button", { name: "编辑 super.admin" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "删除 super.admin" }),
    ).toBeInTheDocument();
    expect(client.listAccounts).toHaveBeenCalledOnce();
  });

  it("超级管理员可通过独立地址进入客户项目和 MCP 工具配置", async () => {
    const client = createClient();
    render(
      <RequirementWorkbench
        client={client}
        actorName="超级管理员"
        actorUsername="super.admin"
        roles={["administrator"]}
      />,
    );

    await userEvent.click(screen.getByRole("link", { name: "客户与项目" }));
    expect(window.location.pathname).toBe("/platform/projects");
    expect(
      await screen.findByRole("heading", { name: "客户与项目" }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "MCP 与外部工具" }));
    expect(window.location.pathname).toBe("/platform/integrations");
    expect(
      await screen.findByRole("heading", { name: "MCP 与外部工具" }),
    ).toBeInTheDocument();
  });

  it("普通账号看不到账号管理且不能通过地址直接进入", async () => {
    window.history.replaceState(null, "", "/platform/projects");
    const client = createClient();
    render(
      <RequirementWorkbench
        client={client}
        actorName="产品负责人"
        actorUsername="product.owner"
        roles={["product_owner"]}
      />,
    );

    await waitFor(() => expect(window.location.pathname).toBe("/dashboard"));
    expect(
      screen.queryByRole("link", { name: "账号管理" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "客户与项目" }),
    ).not.toBeInTheDocument();
    expect(client.listAccounts).not.toHaveBeenCalled();
  });
});
