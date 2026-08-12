// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IntegrationManagement,
  PlatformConfigurationCenter,
  type ForgeXClient,
} from "../src/index.js";

const overview = {
  customers: [
    {
      name: "保险事业群",
      summary: "负责保险客户的智能交付项目",
      enabled: true,
      revision: 1,
      links: {
        self: "/api/v1/platform/customers/11111111-1111-4111-8111-111111111111",
        actions: {
          createProject:
            "/api/v1/platform/customers/11111111-1111-4111-8111-111111111111/projects",
        },
      },
      projects: [
        {
          name: "智能质检平台",
          summary: "管理质检规则与模型交付",
          enabled: true,
          revision: 1,
          links: {
            self: "/api/v1/platform/projects/22222222-2222-4222-8222-222222222222",
            initialization:
              "/api/v1/platform/projects/22222222-2222-4222-8222-222222222222/initialization",
            extensions:
              "/api/v1/projects/22222222-2222-4222-8222-222222222222/extensions",
            actions: {
              createRepository:
                "/api/v1/platform/projects/22222222-2222-4222-8222-222222222222/repositories",
              initialize:
                "/api/v1/platform/projects/22222222-2222-4222-8222-222222222222/initialization",
            },
          },
          repositories: [
            {
              name: "控制面",
              gitUrl: "https://gitee.com/example/control-plane.git",
              localPath: "D:\\forgex\\control-plane",
              defaultBranch: "main",
              enabled: true,
              revision: 1,
              links: {
                self: "/api/v1/platform/repositories/33333333-3333-4333-8333-333333333333",
              },
            },
          ],
        },
      ],
    },
  ],
};

const createClient = (): ForgeXClient =>
  ({
    listPlatformConfiguration: vi.fn().mockResolvedValue(overview),
    createPlatformCustomer: vi.fn().mockResolvedValue(undefined),
    updatePlatformCustomer: vi.fn().mockResolvedValue(undefined),
    deletePlatformCustomer: vi.fn().mockResolvedValue(undefined),
    createPlatformProject: vi.fn().mockResolvedValue(undefined),
    updatePlatformProject: vi.fn().mockResolvedValue(undefined),
    deletePlatformProject: vi.fn().mockResolvedValue(undefined),
    createProjectRepository: vi.fn().mockResolvedValue(undefined),
    updateProjectRepository: vi.fn().mockResolvedValue(undefined),
    deleteProjectRepository: vi.fn().mockResolvedValue(undefined),
    listExtensions: vi.fn().mockResolvedValue({
      businessKnowledge: [],
      teamCapabilities: [],
      externalTools: [],
    }),
  }) as unknown as ForgeXClient;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("平台资源配置", () => {
  it("按客户、项目、多个代码仓库展示 Git 地址和本地路径", async () => {
    render(<PlatformConfigurationCenter client={createClient()} />);

    expect(
      await screen.findByRole("heading", { name: "客户与项目" }),
    ).toBeInTheDocument();
    expect(screen.getByText("保险事业群")).toBeInTheDocument();
    expect(screen.getByText("智能质检平台")).toBeInTheDocument();
    expect(screen.getByText("控制面")).toBeInTheDocument();
    expect(
      screen.getByText("https://gitee.com/example/control-plane.git"),
    ).toBeInTheDocument();
    expect(screen.getByText("D:\\forgex\\control-plane")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "为 保险事业群 新建项目" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "为 智能质检平台 新增代码仓库" }),
    ).toBeInTheDocument();
  });

  it("超级管理员可以从页面创建客户", async () => {
    const client = createClient();
    render(<PlatformConfigurationCenter client={client} />);

    await screen.findByText("保险事业群");
    await userEvent.click(screen.getByRole("button", { name: "新建客户" }));
    await userEvent.type(screen.getByLabelText("客户名称"), "制造事业群");
    await userEvent.type(
      screen.getByLabelText("客户说明"),
      "负责制造行业客户项目",
    );
    await userEvent.click(screen.getByRole("button", { name: "保存客户" }));

    expect(client.createPlatformCustomer).toHaveBeenCalledWith({
      name: "制造事业群",
      summary: "负责制造行业客户项目",
    });
  });

  it("加载项目时只读取初始化状态，并由管理员显式应用标准交付预设", async () => {
    const getProjectInitialization = vi.fn().mockResolvedValue({
      status: "not_started",
      preset: { key: "standard-delivery", version: 1, name: "标准 AI 交付" },
      record: null,
      tasks: [
        {
          key: "knowledge",
          name: "补充项目规则资料",
          detail: "加入项目约束、术语和交付说明",
          status: "action_required",
          links: { nextStep: overview.customers[0]!.projects[0]!.links.extensions },
        },
        {
          key: "skill",
          name: "安装并评测团队 Skill",
          detail: "只使用当前项目已通过评测的 Skill",
          status: "action_required",
          links: { nextStep: overview.customers[0]!.projects[0]!.links.extensions },
        },
        {
          key: "mcp",
          name: "连接并验证外部工具",
          detail: "凭据保留在设备本地",
          status: "action_required",
          links: { nextStep: overview.customers[0]!.projects[0]!.links.extensions },
        },
      ],
      links: {
        self: overview.customers[0]!.projects[0]!.links.initialization,
        extensions: overview.customers[0]!.projects[0]!.links.extensions,
        actions: {
          initialize: overview.customers[0]!.projects[0]!.links.initialization,
        },
      },
    });
    const initializeProject = vi.fn().mockImplementation(async () => ({
      ...(await getProjectInitialization()),
      status: "action_required",
      record: {
        presetKey: "standard-delivery",
        presetVersion: 1,
        initializedBy: "超级管理员",
        initializedAt: "2026-08-12T10:00:00.000Z",
      },
    }));
    const client = {
      ...createClient(),
      getProjectInitialization,
      initializeProject,
    } as unknown as ForgeXClient;

    render(<PlatformConfigurationCenter client={client} />);

    expect(
      await screen.findByRole("heading", { name: "标准交付准备" }),
    ).toBeInTheDocument();
    expect(getProjectInitialization).toHaveBeenCalledWith(
      overview.customers[0]!.projects[0]!.links.initialization,
    );
    expect(initializeProject).not.toHaveBeenCalled();
    expect(screen.getByText("补充项目规则资料")).toBeInTheDocument();
    expect(screen.getByText("安装并评测团队 Skill")).toBeInTheDocument();
    expect(screen.getByText("连接并验证外部工具")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "应用标准交付预设" }),
    );

    expect(initializeProject).toHaveBeenCalledWith(
      overview.customers[0]!.projects[0]!.links.initialization,
      expect.objectContaining({
        presetKey: "standard-delivery",
        presetVersion: 1,
        requestKey: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
        ),
      }),
    );
    expect(await screen.findByText("已应用，继续完成 3 项准备")).toBeInTheDocument();
  });
});

describe("MCP 与外部工具配置", () => {
  it("通过公网 HTTP 访问时仍能生成本地连接标识", async () => {
    const secureCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: secureCrypto.getRandomValues.bind(secureCrypto),
    });

    render(<IntegrationManagement client={createClient()} />);

    expect(
      await screen.findByRole("heading", { name: "MCP 与外部工具" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    ).toBeInTheDocument();
  });

  it("在浏览器本地生成可信发布输入并给出后续命令", async () => {
    render(<IntegrationManagement client={createClient()} />);

    expect(
      await screen.findByRole("heading", { name: "MCP 与外部工具" }),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("MCP 服务名称"), "团队通知服务");
    await userEvent.type(
      screen.getByLabelText("服务用途"),
      "通过客户设备发送团队业务通知",
    );
    await userEvent.type(
      screen.getByLabelText("服务地址"),
      "http://127.0.0.1:3210/mcp",
    );
    await userEvent.type(
      screen.getByLabelText("工具技术名称"),
      "notifications.send",
    );
    await userEvent.type(screen.getByLabelText("业务动作名称"), "发送团队通知");
    await userEvent.type(
      screen.getByLabelText("业务动作说明"),
      "向指定团队成员发送一条业务通知",
    );
    await userEvent.selectOptions(
      screen.getByLabelText("操作影响"),
      "external_action",
    );
    await userEvent.click(screen.getByRole("button", { name: "生成本地配置" }));

    const output = screen.getByLabelText("MCP 本地发布配置");
    expect((output as HTMLTextAreaElement).value).toContain(
      '"connectionBindingKey"',
    );
    expect((output as HTMLTextAreaElement).value).toContain(
      '"external_action"',
    );
    expect(
      screen.getByText(
        /npm run --workspace @forgex\/extension-admin admin -- mcp-pack/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/配置只在当前浏览器生成/)).toBeInTheDocument();
  });
});
