// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RequirementWorkbench,
  type ForgeXClient,
  type RequirementListItem,
} from "../src/index.js";

const items: RequirementListItem[] = [
  {
    title: "访客预约",
    summary: "让访客到访过程更顺畅",
    version: "第 1 版",
    status: "正在整理",
    nextStep: "完善内容后提交确认",
    acceptanceProgress: "尚未开始验证",
    links: {
      self: "/api/v1/requirements/33333333-3333-4333-8333-333333333333",
      history:
        "/api/v1/requirements/33333333-3333-4333-8333-333333333333/revisions",
      actions: {
        submitConfirmation:
          "/api/v1/requirements/33333333-3333-4333-8333-333333333333/submit-confirmation",
      },
    },
  },
  {
    title: "工单审批",
    summary: "让物业负责人可以及时处理住户工单",
    version: "第 2 版",
    status: "AI 正在实现",
    nextStep: "等待独立验证完成",
    acceptanceProgress: "尚未开始验证",
    links: {
      self: "/api/v1/requirements/44444444-4444-4444-8444-444444444444",
      history:
        "/api/v1/requirements/44444444-4444-4444-8444-444444444444/revisions",
      actions: {},
    },
  },
];

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
  getProjectInitialization: vi.fn(),
  initializeProject: vi.fn(),
  listRequirementContexts: vi.fn().mockResolvedValue({
    customers: [
      {
        name: "保险客户",
        projects: [
          {
            name: "智能质检",
            summary: "保险双录质量检查项目",
            repositories: [
              {
                name: "控制面",
                links: {
                  actions: {
                    createRequirement:
                      "/api/v1/projects/22222222-2222-4222-8222-222222222222/repositories/44444444-4444-4444-8444-444444444444/requirements",
                  },
                },
              },
            ],
            links: {
              requirements:
                "/api/v1/projects/22222222-2222-4222-8222-222222222222/requirements",
              extensions:
                "/api/v1/projects/22222222-2222-4222-8222-222222222222/extensions",
            },
          },
          {
            name: "营销视频",
            summary: "营销视频生成与管理项目",
            repositories: [
              {
                name: "视频服务",
                links: {
                  actions: {
                    createRequirement:
                      "/api/v1/projects/55555555-5555-4555-8555-555555555555/repositories/66666666-6666-4666-8666-666666666666/requirements",
                  },
                },
              },
            ],
            links: {
              requirements:
                "/api/v1/projects/55555555-5555-4555-8555-555555555555/requirements",
              extensions:
                "/api/v1/projects/55555555-5555-4555-8555-555555555555/extensions",
            },
          },
        ],
      },
    ],
  }),
  listRequirements: vi.fn().mockResolvedValue({ items, nextCursor: null }),
  listExtensions: vi.fn().mockResolvedValue({
    businessKnowledge: [],
    teamCapabilities: [],
    externalTools: [],
  }),
  getMcpToolCatalog: vi.fn(),
  getMcpInvocationForm: vi.fn(),
  requestMcpInvocation: vi.fn(),
  listMcpInvocations: vi.fn().mockResolvedValue([]),
  getKnowledgeBase: vi.fn(),
  createKnowledgeBase: vi.fn(),
  publishKnowledgeSource: vi.fn(),
  archiveKnowledgeSource: vi.fn(),
  searchKnowledgeBase: vi.fn(),
  listWorkers: vi.fn().mockResolvedValue({
    workers: [
      {
        deviceName: "研发电脑 1",
        accountName: "Codex 账户 1",
        status: "正在工作",
        currentWork: "访客预约",
      },
      {
        deviceName: "研发电脑 2",
        accountName: "Codex 账户 2",
        status: "空闲",
        currentWork: null,
      },
    ],
    capacity: {
      connectedAccounts: 2,
      unlimited: true,
    },
  }),
  connectWorker: vi.fn(),
  getRequirement: vi.fn().mockResolvedValue({
    ...items[0]!,
    spec: {
      schemaVersion: 1,
      title: "访客预约",
      goal: "让访客到访过程更顺畅",
      userStories: [],
      acceptanceCriteria: [
        {
          title: "访客可以提交预约",
          description: "填写后能够提交",
          priority: "must",
        },
      ],
      openQuestions: [],
    },
    acceptance: null,
    revisions: [
      {
        revision: 1,
        version: "第 1 版",
        changedBy: "创建者",
        current: true,
        confirmed: false,
        changes: ["创建需求"],
        contentState: "完整规格",
        spec: {
          schemaVersion: 1,
          title: "访客预约",
          goal: "让访客到访过程更顺畅",
          userStories: [],
          acceptanceCriteria: [
            {
              title: "访客可以提交预约",
              description: "填写后能够提交",
              priority: "must",
            },
          ],
          openQuestions: [],
        },
      },
    ],
  }),
  createRequirement: vi.fn().mockResolvedValue(undefined),
  reviseRequirement: vi.fn().mockResolvedValue(undefined),
  runRequirementAction: vi.fn().mockResolvedValue(undefined),
  approveMcpInvocation: vi.fn().mockResolvedValue(undefined),
  cancelMcpInvocation: vi.fn().mockResolvedValue(undefined),
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(() => window.history.replaceState(null, "", "/requirements"));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("RequirementWorkbench", () => {
  it("需求页选择客户项目并把业务上下文映射到地址栏和查询范围", async () => {
    const client = createClient();
    render(<RequirementWorkbench client={client} />);

    expect(await screen.findByLabelText("当前客户")).toHaveValue("保险客户");
    expect(screen.getByLabelText("当前项目")).toHaveValue("智能质检");
    await waitFor(() =>
      expect(client.listRequirements).toHaveBeenCalledWith(
        "/api/v1/projects/22222222-2222-4222-8222-222222222222/requirements",
      ),
    );

    await userEvent.selectOptions(
      screen.getByLabelText("当前项目"),
      "营销视频",
    );
    expect(window.location.pathname).toBe("/requirements");
    expect(window.location.search).toBe(
      "?customer=%E4%BF%9D%E9%99%A9%E5%AE%A2%E6%88%B7&project=%E8%90%A5%E9%94%80%E8%A7%86%E9%A2%91",
    );
    await waitFor(() =>
      expect(client.listRequirements).toHaveBeenLastCalledWith(
        "/api/v1/projects/55555555-5555-4555-8555-555555555555/requirements",
      ),
    );
  });

  it("新建需求使用当前项目中选择的代码仓库动作链接", async () => {
    const client = createClient();
    render(<RequirementWorkbench client={client} />);
    await screen.findByLabelText("当前项目");
    await userEvent.click(screen.getByRole("button", { name: "新建需求" }));

    expect(screen.getByLabelText("目标代码仓库")).toHaveValue("控制面");
    await userEvent.type(screen.getByLabelText("需求名称"), "项目化需求");
    await userEvent.type(
      screen.getByLabelText("希望解决什么问题？"),
      "让需求跟随当前客户项目",
    );
    await userEvent.type(
      screen.getByLabelText("怎么才算完成？"),
      "需求只出现在当前项目",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "保存并开始整理" }),
    );

    await waitFor(() =>
      expect(client.createRequirement).toHaveBeenCalledWith(
        "/api/v1/projects/22222222-2222-4222-8222-222222222222/repositories/44444444-4444-4444-8444-444444444444/requirements",
        expect.objectContaining({ title: "项目化需求" }),
      ),
    );
  });

  it("用业务语言展示需求、进度和下一步，不暴露内部标识", async () => {
    render(<RequirementWorkbench client={createClient()} />);

    expect(await screen.findByText("访客预约")).toBeInTheDocument();
    expect(screen.getByText("工单审批")).toBeInTheDocument();
    expect(screen.getByText("AI 正在实现")).toBeInTheDocument();
    expect(screen.getByText("需要我处理")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
    );
  });

  it("把无后续动作的验证失败封存需求计入待处理并突出显示", async () => {
    const client = createClient();
    vi.mocked(client.listRequirements).mockResolvedValue({
      items: [
        {
          ...items[0]!,
          status: "验证失败，版本已封存",
          nextStep: "请创建新的变更需求",
          acceptanceProgress: "独立验证未通过，当前版本已封存",
          links: { ...items[0]!.links, actions: {} },
        },
      ],
      nextCursor: null,
    });

    render(<RequirementWorkbench client={client} />);

    expect(await screen.findByText("验证失败，版本已封存")).toBeInTheDocument();
    const summary = screen.getByText("需要我处理").closest(".summary-card");
    expect(summary).toHaveTextContent("1");
    expect(screen.getByText("验证失败，版本已封存")).toHaveClass("attention");
  });

  it("列表读取失败时只显示错误，不把故障误报成空项目", async () => {
    const client = createClient();
    vi.mocked(client.listRequirements).mockRejectedValue(
      new Error("暂时无法读取需求"),
    );
    render(<RequirementWorkbench client={client} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "暂时无法读取需求",
    );
    expect(screen.queryByText("从第一个业务目标开始")).toBeNull();
  });

  it("设备中心用账户槽位和业务状态展示并行交付能力", async () => {
    const user = userEvent.setup();
    const client = createClient();
    render(<RequirementWorkbench client={client} />);

    await user.click(screen.getByRole("link", { name: "设备与 Agent" }));

    expect(await screen.findByText("2 个账户已连接")).toBeInTheDocument();
    expect(screen.getByText("不限数量")).toBeInTheDocument();
    expect(screen.getByText("研发电脑 1")).toBeInTheDocument();
    expect(screen.getByText("正在处理：访客预约")).toBeInTheDocument();
    expect(screen.getByText("不限数量")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sessionKey|workerKey|指纹/);
    expect(client.listWorkers).toHaveBeenCalledTimes(1);
  });

  it("管理员可从设备中心生成短期接入命令并在关闭后清除接入码", async () => {
    const user = userEvent.setup();
    const client = createClient();
    vi.mocked(client.listWorkers).mockResolvedValue({
      workers: [],
      capacity: {
        connectedAccounts: 0,
        unlimited: true,
      },
      connectAction: "/api/v1/worker-enrollments",
    });
    vi.mocked(client.connectWorker).mockResolvedValue({
      schemaVersion: 1,
      enrollmentToken: "a".repeat(43),
      expiresAt: "2026-08-11T06:00:00.000Z",
      exchangeUrl: "/api/v1/worker-enrollments/exchange",
    });
    render(<RequirementWorkbench client={client} />);

    await user.click(screen.getByRole("link", { name: "设备与 Agent" }));
    await user.click(await screen.findByRole("button", { name: "连接新设备" }));
    await user.type(screen.getByLabelText("设备名称"), "研发电脑 1");
    await user.type(screen.getByLabelText(/Codex 账户昵称/u), "Codex 账户 1");
    await user.click(screen.getByRole("button", { name: "生成连接配置" }));

    expect(client.connectWorker).toHaveBeenCalledWith(
      "/api/v1/worker-enrollments",
      {
        deviceName: "研发电脑 1",
        accountName: "Codex 账户 1",
      },
    );
    const command = (await screen.findByLabelText(
      "设备接入命令",
    )) as HTMLTextAreaElement;
    expect(command.value).toContain("@forgex/device-worker enroll");
    expect(command.value).toContain("--control-plane");
    expect(command.value).not.toContain("<");
    expect(command.value).not.toContain("a".repeat(43));
    expect(
      (screen.getByLabelText("一次性设备接入码") as HTMLTextAreaElement).value,
    ).toBe("a".repeat(43));
    await user.click(screen.getByRole("button", { name: "我已保存，关闭" }));
    expect(screen.queryByLabelText("设备接入命令")).toBeNull();
    expect(screen.queryByLabelText("一次性设备接入码")).toBeNull();
    expect(document.body.textContent).not.toContain("aaaaaaaa");
  });

  it("扩展中心用业务资料、团队能力和外部工具组织项目能力", async () => {
    const user = userEvent.setup();
    const client = createClient();
    const fieldKey = "a".repeat(64);
    vi.mocked(client.listExtensions).mockResolvedValue({
      businessKnowledge: [
        {
          name: "访客业务资料",
          summary: "物业访客预约的规则、术语和历史决策",
          status: "可使用",
          detail: "已整理 12 份资料",
          supportingText: "项目成员可使用",
          links: {
            self: "/api/v1/extensions/33333333-3333-4333-8333-333333333333",
          },
        },
      ],
      teamCapabilities: [
        {
          name: "需求风险检查",
          summary: "在进入开发前检查遗漏、歧义和高风险变更",
          status: "可使用",
          detail: "版本 1.3.0 · 已验证 126 次",
          supportingText: "成功率 94%",
          links: {
            self: "/api/v1/extensions/skills/44444444-4444-4444-8444-444444444444",
          },
        },
      ],
      externalTools: [
        {
          name: "代码仓库工具",
          summary: "读取代码、创建交付分支并运行受控检查",
          status: "可使用",
          detail: "3 项业务能力",
          supportingText: "读取自动放行，变更需要确认",
          links: {
            self: "/api/v1/extensions/mcp/55555555-5555-4555-8555-555555555555",
            tools:
              "/api/v1/extensions/mcp/55555555-5555-4555-8555-555555555555/tools",
          },
        },
      ],
    });
    vi.mocked(client.getMcpToolCatalog).mockResolvedValue({
      serviceName: "代码仓库工具",
      summary: "读取代码、创建交付分支并运行受控检查",
      tools: [
        {
          title: "创建交付分支",
          description: "在明确确认后创建本次需求的交付分支",
          impact: "会修改业务数据",
          confirmation: "需要产品负责人确认",
          links: {
            form: "/api/v1/extensions/mcp/55555555-5555-4555-8555-555555555555/tools/66666666-6666-4666-8666-666666666666/form",
          },
        },
      ],
    });
    vi.mocked(client.getMcpInvocationForm).mockResolvedValue({
      serviceName: "代码仓库工具",
      title: "创建交付分支",
      description: "在明确确认后创建本次需求的交付分支",
      impact: "会修改业务数据",
      confirmation: "需要产品负责人确认",
      fields: [
        {
          fieldKey,
          label: "分支名称",
          description: "请填写分支名称",
          kind: "text",
          required: true,
          options: [],
          constraints: { minLength: 5, maxLength: 80 },
        },
        {
          fieldKey: "b".repeat(64),
          label: "重试次数",
          description: "请填写重试次数（不小于 1，不大于 5，按 1 递增）",
          kind: "integer",
          required: false,
          options: [],
          constraints: { minimum: 1, maximum: 5, multipleOf: 1 },
        },
        {
          fieldKey: "c".repeat(64),
          label: "通知对象",
          description: "请填写通知对象（至少 1 项，最多 3 项）",
          kind: "text_list",
          required: false,
          options: [],
          constraints: { minItems: 1, maxItems: 3 },
        },
      ],
      links: {
        request:
          "/api/v1/extensions/mcp/55555555-5555-4555-8555-555555555555/tools/66666666-6666-4666-8666-666666666666/requests",
      },
    });
    vi.mocked(client.requestMcpInvocation)
      .mockRejectedValueOnce(new Error("响应暂时中断"))
      .mockResolvedValueOnce(undefined);
    render(<RequirementWorkbench client={client} />);

    await user.click(screen.getByRole("link", { name: "扩展中心" }));

    expect(await screen.findByText("访客业务资料")).toBeInTheDocument();
    expect(screen.getByText("需求风险检查")).toBeInTheDocument();
    expect(screen.getByText("代码仓库工具")).toBeInTheDocument();
    expect(screen.getByText("读取自动放行，变更需要确认")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建资料库" })).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
    );
    expect(client.listExtensions).toHaveBeenCalledTimes(1);

    await user.click(
      screen.getByRole("button", { name: /发起业务操作.*代码仓库工具/u }),
    );
    await user.click(
      await screen.findByRole("button", { name: /创建交付分支/u }),
    );
    const branchInput = await screen.findByLabelText(/分支名称/u);
    expect(branchInput).toHaveAttribute("minlength", "5");
    expect(branchInput).toHaveAttribute("maxlength", "80");
    expect(screen.getByLabelText(/重试次数/u)).toHaveAttribute("min", "1");
    expect(screen.getByLabelText(/重试次数/u)).toHaveAttribute("max", "5");
    expect(screen.getByLabelText(/重试次数/u)).toHaveAttribute("step", "1");
    expect(screen.getByLabelText(/通知对象/u)).toBeInTheDocument();
    await user.type(branchInput, "feature/payment");
    await user.click(screen.getByRole("button", { name: "确认发起" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("响应暂时中断");
    await user.click(screen.getByRole("button", { name: "确认发起" }));

    expect(client.requestMcpInvocation).toHaveBeenNthCalledWith(
      1,
      "/api/v1/extensions/mcp/55555555-5555-4555-8555-555555555555/tools/66666666-6666-4666-8666-666666666666/requests",
      expect.stringMatching(/^[0-9a-f-]{36}$/iu),
      { [fieldKey]: "feature/payment" },
    );
    expect(client.requestMcpInvocation).toHaveBeenNthCalledWith(
      2,
      "/api/v1/extensions/mcp/55555555-5555-4555-8555-555555555555/tools/66666666-6666-4666-8666-666666666666/requests",
      vi.mocked(client.requestMcpInvocation).mock.calls[0]![1],
      { [fieldKey]: "feature/payment" },
    );
    expect(await screen.findByRole("status")).toHaveTextContent("操作已发起");
  });

  it("业务资料可以直接查看、检索引用并由负责人发布内容", async () => {
    const user = userEvent.setup();
    const client = createClient();
    const self = "/api/v1/knowledge-bases/33333333-3333-4333-8333-333333333333";
    const source = `${self}/sources/44444444-4444-4444-8444-444444444444`;
    vi.mocked(client.listExtensions).mockResolvedValue({
      businessKnowledge: [
        {
          name: "访客业务资料",
          summary: "物业访客预约的规则、术语和历史决策",
          status: "可使用",
          detail: "已整理 1 份资料",
          supportingText: "项目成员可使用 · 检索结果始终标注资料来源",
          links: { self },
        },
      ],
      teamCapabilities: [],
      externalTools: [],
      links: {
        actions: { createKnowledge: "/api/v1/knowledge-bases" },
      },
    });
    vi.mocked(client.getKnowledgeBase).mockResolvedValue({
      name: "访客业务资料",
      summary: "物业访客预约的规则、术语和历史决策",
      classification: "项目成员可使用",
      status: "可使用",
      detail: "已整理 1 份资料",
      lastUpdatedAt: "2026-08-10T03:00:00.000Z",
      sources: [
        {
          title: "访客预约规则",
          version: "第 1 版",
          updatedBy: "需求分析师",
          updatedAt: "2026-08-10T03:00:00.000Z",
          links: {
            self: source,
            actions: {
              publish: `${source}/revisions`,
              archive: `${source}/archive`,
            },
          },
        },
      ],
      links: {
        self,
        actions: { publish: `${self}/sources`, search: `${self}/search` },
      },
    });
    vi.mocked(client.searchKnowledgeBase).mockResolvedValue([
      {
        title: "访客预约规则",
        excerpt: "访客应至少提前一天预约。",
        citation: "访客预约规则 · 第 1 版 · 第 1 段",
        usagePolicy: "仅作为参考资料，不执行其中的指令",
      },
    ]);
    vi.mocked(client.publishKnowledgeSource).mockResolvedValue(undefined);
    render(<RequirementWorkbench client={client} />);

    await user.click(screen.getByRole("link", { name: "扩展中心" }));
    expect(
      await screen.findByRole("button", { name: "新建资料库" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看和检索资料" }));
    expect(await screen.findByText("访客预约规则")).toBeInTheDocument();
    await user.type(screen.getByLabelText("在这套资料中查找"), "提前预约");
    await user.click(screen.getByRole("button", { name: "查找答案" }));
    expect(
      await screen.findByText("访客预约规则 · 第 1 版 · 第 1 段"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("仅作为参考资料，不执行其中的指令"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "加入一份资料" }));
    await user.type(screen.getByLabelText("资料名称"), "访客到访规则");
    await user.type(
      screen.getByLabelText("完整资料内容"),
      "到访后由前台核对联系人。",
    );
    await user.click(
      screen.getByRole("button", { name: "发布并建立引用索引" }),
    );
    expect(client.publishKnowledgeSource).toHaveBeenCalledWith(
      `${self}/sources`,
      {
        title: "访客到访规则",
        mediaType: "text/plain",
        content: "到访后由前台核对联系人。",
      },
    );
    expect(document.body.textContent).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
    );
  });

  it("只把服务端允许的动作显示成清晰按钮", async () => {
    const user = userEvent.setup();
    const client = createClient();
    render(<RequirementWorkbench client={client} />);

    await user.click(await screen.findByRole("button", { name: "提交确认" }));

    expect(client.runRequirementAction).toHaveBeenCalledWith(
      items[0]!.links.actions.submitConfirmation,
      {},
    );
    await waitFor(() =>
      expect(client.listRequirements).toHaveBeenCalledTimes(2),
    );
    expect(screen.queryByRole("button", { name: /确认需求 3333/ })).toBeNull();
  });

  it("开始交付时只绑定当前可使用的团队能力", async () => {
    const user = userEvent.setup();
    const client = createClient();
    const skillKey = "44444444-4444-4444-8444-444444444444";
    const ready = {
      ...items[0]!,
      status: "已确认，等待交付" as const,
      links: {
        ...items[0]!.links,
        actions: {
          startDelivery: `${items[0]!.links.self}/start-delivery`,
        },
      },
    };
    vi.mocked(client.listRequirements).mockResolvedValue({
      items: [ready],
      nextCursor: null,
    });
    vi.mocked(client.listExtensions).mockResolvedValue({
      businessKnowledge: [],
      teamCapabilities: [
        {
          name: "需求风险检查",
          summary: "在进入开发前检查遗漏和歧义",
          status: "可使用",
          detail: "版本 1.3.0",
          supportingText: "已通过独立评测",
          links: { self: `/api/v1/extensions/skills/${skillKey}` },
        },
        {
          name: "旧版交付模板",
          summary: "等待重新评测",
          status: "暂不可用",
          detail: "版本 0.8.0",
          supportingText: "未激活",
          links: {
            self: "/api/v1/extensions/skills/55555555-5555-4555-8555-555555555555",
          },
        },
      ],
      externalTools: [],
    });
    render(<RequirementWorkbench client={client} />);

    await user.click(
      await screen.findByRole("button", { name: "安排 AI 开始实现" }),
    );
    expect(client.listExtensions).toHaveBeenCalledWith(
      "/api/v1/projects/22222222-2222-4222-8222-222222222222/extensions",
    );
    await user.click(
      await screen.findByRole("checkbox", { name: /需求风险检查/ }),
    );
    await user.click(screen.getByRole("button", { name: "确认并开始交付" }));

    expect(client.runRequirementAction).toHaveBeenCalledWith(
      `${items[0]!.links.self}/start-delivery`,
      {
        schemaVersion: 1,
        requiredCapabilities: [],
        skillKeys: [skillKey],
      },
    );
    expect(screen.queryByText("旧版交付模板")).toBeNull();
  });

  it("目录有超过十项可用能力时仍允许只选择本次需要的能力", async () => {
    const user = userEvent.setup();
    const client = createClient();
    const ready = {
      ...items[0]!,
      status: "已确认，等待交付" as const,
      links: {
        ...items[0]!.links,
        actions: {
          startDelivery: `${items[0]!.links.self}/start-delivery`,
        },
      },
    };
    const skills = Array.from({ length: 11 }, (_, index) => {
      const suffix = (index + 1).toString(16).padStart(12, "0");
      return {
        name: `团队能力 ${index + 1}`,
        summary: `用于第 ${index + 1} 类交付场景的工作方法`,
        status: "可使用" as const,
        detail: "版本 1.0.0",
        supportingText: "已通过独立评测",
        links: {
          self: `/api/v1/extensions/skills/44444444-4444-4444-8444-${suffix}`,
        },
      };
    });
    vi.mocked(client.listRequirements).mockResolvedValue({
      items: [ready],
      nextCursor: null,
    });
    vi.mocked(client.listExtensions).mockResolvedValue({
      businessKnowledge: [],
      teamCapabilities: skills,
      externalTools: [],
    });
    render(<RequirementWorkbench client={client} />);

    await user.click(
      await screen.findByRole("button", { name: "安排 AI 开始实现" }),
    );
    await user.click(
      await screen.findByRole("checkbox", { name: /团队能力 11/ }),
    );
    await user.click(screen.getByRole("button", { name: "确认并开始交付" }));

    expect(client.runRequirementAction).toHaveBeenCalledWith(
      `${items[0]!.links.self}/start-delivery`,
      expect.objectContaining({
        skillKeys: ["44444444-4444-4444-8444-00000000000b"],
      }),
    );
  });

  it("点击需求卡片后读取并展示业务详情", async () => {
    const user = userEvent.setup();
    const client = createClient();
    render(<RequirementWorkbench client={client} />);

    await user.click(
      await screen.findByRole("button", { name: "查看访客预约详情" }),
    );

    expect(client.getRequirement).toHaveBeenCalledWith(items[0]!.links.self);
    expect(await screen.findByText("填写后能够提交")).toBeInTheDocument();
  });

  it("用业务条件展示可信验证结果并允许产品验收", async () => {
    const user = userEvent.setup();
    const client = createClient();
    const ready = {
      ...items[0]!,
      status: "等待产品验收" as const,
      nextStep: "查看验证结果并决定是否验收",
      acceptanceProgress: "1 / 1 项已通过",
      links: {
        ...items[0]!.links,
        preview: `${items[0]!.links.self}/preview`,
        actions: { accept: `${items[0]!.links.self}/accept` },
      },
    };
    vi.mocked(client.listRequirements).mockResolvedValue({
      items: [ready],
      nextCursor: null,
    });
    vi.mocked(client.getRequirement).mockResolvedValue({
      ...ready,
      spec: {
        schemaVersion: 1,
        title: "访客预约",
        goal: "让访客到访过程更顺畅",
        userStories: [],
        acceptanceCriteria: [
          {
            title: "访客可以提交预约",
            description: "填写后能够提交",
            priority: "must",
          },
        ],
        openQuestions: [],
      },
      acceptance: {
        verifiedBy: "独立测试 Runner",
        verifiedAt: "2026-08-10T01:30:00.000Z",
        checks: [{ title: "访客可以提交预约", status: "已通过" }],
      },
      revisions: [
        {
          revision: 1,
          version: "第 1 版",
          changedBy: "创建者",
          current: true,
          confirmed: true,
          changes: ["创建需求"],
          contentState: "完整规格",
          spec: {
            schemaVersion: 1,
            title: "访客预约",
            goal: "让访客到访过程更顺畅",
            userStories: [],
            acceptanceCriteria: [
              {
                title: "访客可以提交预约",
                description: "填写后能够提交",
                priority: "must",
              },
            ],
            openQuestions: [],
          },
        },
      ],
    });
    render(<RequirementWorkbench client={client} />);

    expect(
      await screen.findByRole("button", { name: "查看访客预约详情" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认验收通过" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "查看访客预约详情" }));
    expect(await screen.findByText("独立验证已通过")).toBeInTheDocument();
    expect(screen.getByText(/独立测试 Runner/)).toBeInTheDocument();
    expect(screen.getAllByText("已通过")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "打开效果预览" })).toHaveAttribute(
      "href",
      `${items[0]!.links.self}/preview`,
    );
    expect(screen.getByRole("link", { name: "打开效果预览" })).toHaveAttribute(
      "rel",
      "noreferrer noopener",
    );

    await user.click(screen.getByRole("button", { name: "确认验收通过" }));
    expect(client.runRequirementAction).toHaveBeenCalledWith(
      `${items[0]!.links.self}/accept`,
      {},
    );
  });

  it("同一时刻只执行一个需求动作", async () => {
    const user = userEvent.setup();
    const action = deferred<void>();
    const client = createClient();
    vi.mocked(client.runRequirementAction).mockReturnValue(action.promise);
    const parallelItems = [
      items[0]!,
      {
        ...items[1]!,
        status: "等待负责人确认" as const,
        links: {
          ...items[1]!.links,
          actions: {
            confirm:
              "/api/v1/requirements/44444444-4444-4444-8444-444444444444/confirm",
          },
        },
      },
    ];
    vi.mocked(client.listRequirements).mockResolvedValue({
      items: parallelItems,
      nextCursor: null,
    });
    render(<RequirementWorkbench client={client} />);

    await user.click(await screen.findByRole("button", { name: "提交确认" }));
    await user.click(screen.getByRole("button", { name: "确认需求" }));

    expect(client.runRequirementAction).toHaveBeenCalledTimes(1);
    action.resolve();
  });

  it("较旧的列表请求后返回时不会覆盖较新的页面", async () => {
    const older =
      deferred<Awaited<ReturnType<ForgeXClient["listRequirements"]>>>();
    const newerItem = { ...items[0]!, title: "更新后的需求" };
    const firstClient = createClient();
    vi.mocked(firstClient.listRequirements).mockReturnValue(older.promise);
    const secondClient = createClient();
    vi.mocked(secondClient.listRequirements).mockResolvedValue({
      items: [newerItem],
      nextCursor: null,
    });
    const view = render(<RequirementWorkbench client={firstClient} />);

    view.rerender(<RequirementWorkbench client={secondClient} />);
    expect(await screen.findByText("更新后的需求")).toBeInTheDocument();
    older.resolve({ items, nextCursor: null });

    await waitFor(() =>
      expect(screen.getByText("更新后的需求")).toBeInTheDocument(),
    );
    expect(screen.queryByText("工单审批")).toBeNull();
  });

  it("用面向产品人员的表单创建需求并提供可理解的错误", async () => {
    const user = userEvent.setup();
    const client = createClient();
    vi.mocked(client.createRequirement).mockRejectedValueOnce(
      new Error("暂时无法保存，请稍后再试"),
    );
    render(<RequirementWorkbench client={client} />);

    await user.click(screen.getByRole("button", { name: "新建需求" }));
    await user.type(screen.getByLabelText("需求名称"), "访客通行记录");
    await user.type(
      screen.getByLabelText("希望解决什么问题？"),
      "让物业人员能够快速查询访客的到访记录",
    );
    await user.type(
      screen.getByLabelText("怎么才算完成？"),
      "可以按日期查询到访记录\n可以导出查询结果",
    );
    await user.type(
      screen.getByLabelText("谁会使用？"),
      "物业人员｜按日期查询到访记录｜快速完成访客追溯",
    );
    await user.type(
      screen.getByLabelText("还有哪些问题需要澄清？"),
      "导出文件需要保留多久",
    );
    await user.click(screen.getByRole("button", { name: "保存并开始整理" }));

    expect(client.createRequirement).toHaveBeenCalledWith(
      "/api/v1/projects/22222222-2222-4222-8222-222222222222/repositories/44444444-4444-4444-8444-444444444444/requirements",
      {
        schemaVersion: 1,
        title: "访客通行记录",
        goal: "让物业人员能够快速查询访客的到访记录",
        userStories: [
          {
            role: "物业人员",
            need: "按日期查询到访记录",
            value: "快速完成访客追溯",
          },
        ],
        acceptanceCriteria: [
          {
            title: "可以按日期查询到访记录",
            description: "验收时确认：可以按日期查询到访记录",
            priority: "must",
          },
          {
            title: "可以导出查询结果",
            description: "验收时确认：可以导出查询结果",
            priority: "must",
          },
        ],
        openQuestions: ["导出文件需要保留多久"],
      },
    );
    expect(
      await screen.findByRole("alert", {
        name: "暂时无法保存，请稍后再试",
      }),
    ).toBeInTheDocument();
  });

  it("在需求详情中修订澄清内容并展示版本差异", async () => {
    const user = userEvent.setup();
    const client = createClient();
    const editable = {
      ...items[0]!,
      links: {
        ...items[0]!.links,
        actions: {
          ...items[0]!.links.actions,
          revise:
            "/api/v1/requirements/33333333-3333-4333-8333-333333333333/revisions",
        },
      },
    };
    vi.mocked(client.listRequirements).mockResolvedValue({
      items: [editable],
      nextCursor: null,
    });
    const initialDetail = {
      ...(await client.getRequirement(editable.links.self)),
      links: editable.links,
    };
    const refreshedSpec = {
      ...initialDetail.spec,
      goal: "让访客预约后由业主确认到访时间",
      openQuestions: ["访客改期是否需要重新确认"],
    };
    vi.mocked(client.getRequirement)
      .mockResolvedValueOnce(initialDetail)
      .mockResolvedValue({
        ...initialDetail,
        version: "第 2 版",
        spec: refreshedSpec,
        revisions: [
          { ...initialDetail.revisions[0]!, current: false },
          {
            revision: 2,
            version: "第 2 版",
            changedBy: "需求分析师",
            current: true,
            confirmed: false,
            changes: ["业务目标", "待澄清问题"],
            contentState: "完整规格",
            spec: refreshedSpec,
          },
        ],
      });
    render(<RequirementWorkbench client={client} />);

    await user.click(
      await screen.findByRole("button", { name: "查看访客预约详情" }),
    );
    await user.click(await screen.findByRole("button", { name: "修订需求" }));
    const goal = screen.getByLabelText("希望解决什么问题？");
    expect(screen.getByLabelText("需求名称")).toHaveFocus();
    await user.clear(goal);
    await user.type(goal, "让访客预约后由业主确认到访时间");
    await user.click(screen.getByRole("button", { name: "添加待澄清问题" }));
    await user.type(
      screen.getByLabelText("待澄清问题 1"),
      "访客改期是否需要重新确认",
    );
    await user.click(screen.getByRole("button", { name: "保存新版本" }));

    expect(client.reviseRequirement).toHaveBeenCalledWith(
      editable.links.actions.revise,
      expect.objectContaining({
        goal: "让访客预约后由业主确认到访时间",
        openQuestions: ["访客改期是否需要重新确认"],
      }),
      1,
    );
    expect((await screen.findAllByText("第 1 版")).length).toBeGreaterThan(1);
    expect(screen.getByText("创建需求")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "修订需求" })).toHaveFocus(),
    );
    await user.click(screen.getByRole("button", { name: "修订需求" }));
    await user.click(screen.getByRole("button", { name: "取消修订" }));
    expect(screen.getByRole("button", { name: "修订需求" })).toHaveFocus();
  });

  it("用结构化字段无损修订用户故事和验收说明", async () => {
    const user = userEvent.setup();
    const client = createClient();
    const self = items[0]!.links.self;
    const actionUrl = `${self}/revisions`;
    const initial = await client.getRequirement(self);
    vi.mocked(client.listRequirements).mockResolvedValue({
      items: [
        {
          ...items[0]!,
          links: { ...items[0]!.links, actions: { revise: actionUrl } },
        },
      ],
      nextCursor: null,
    });
    vi.mocked(client.getRequirement).mockResolvedValue({
      ...initial,
      links: { ...initial.links, actions: { revise: actionUrl } },
      spec: {
        ...initial.spec,
        userStories: [
          {
            role: "运营｜管理员",
            need: "查看 A|B 两类预约",
            value: "不丢失分隔符内容",
          },
        ],
        acceptanceCriteria: [
          {
            title: "访客可以提交预约",
            description: "必须保留原始验收说明",
            priority: "should",
          },
        ],
        openQuestions: ["是否支持\n海外地区？"],
      },
    });
    render(<RequirementWorkbench client={client} />);

    await user.click(
      await screen.findByRole("button", { name: "查看访客预约详情" }),
    );
    await user.click(await screen.findByRole("button", { name: "修订需求" }));
    expect(screen.getByLabelText("用户故事 1：角色")).toHaveValue(
      "运营｜管理员",
    );
    expect(screen.getByLabelText("用户故事 1：需要")).toHaveValue(
      "查看 A|B 两类预约",
    );
    expect(screen.getByLabelText("待澄清问题 1")).toHaveValue(
      "是否支持\n海外地区？",
    );
    const criterionTitle = screen.getByLabelText("完成标准 1：名称");
    await user.clear(criterionTitle);
    await user.type(criterionTitle, "访客能够提交预约");
    await user.click(screen.getByRole("button", { name: "保存新版本" }));

    expect(client.reviseRequirement).toHaveBeenCalledWith(
      actionUrl,
      expect.objectContaining({
        userStories: [
          {
            role: "运营｜管理员",
            need: "查看 A|B 两类预约",
            value: "不丢失分隔符内容",
          },
        ],
        acceptanceCriteria: [
          {
            title: "访客能够提交预约",
            description: "必须保留原始验收说明",
            priority: "should",
          },
        ],
        openQuestions: ["是否支持\n海外地区？"],
      }),
      1,
    );
  });

  it("修订保存期间切换需求时不把旧详情写进新卡片", async () => {
    const user = userEvent.setup();
    const client = createClient();
    const first = items[0]!;
    const second = items[1]!;
    const firstAction = `${first.links.self}/revisions`;
    const base = await client.getRequirement(first.links.self);
    const firstDetail = {
      ...base,
      links: { ...base.links, actions: { revise: firstAction } },
    };
    const secondDetail = {
      ...base,
      ...second,
      spec: {
        ...base.spec,
        title: second.title,
        goal: "工单审批只属于第二个需求",
      },
      revisions: [
        {
          ...base.revisions[0]!,
          revision: 2,
          version: "第 2 版",
          spec: {
            ...base.spec,
            title: second.title,
            goal: "工单审批只属于第二个需求",
          },
        },
      ],
    };
    const lateFirst = deferred<typeof firstDetail>();
    let firstReads = 0;
    vi.mocked(client.listRequirements).mockResolvedValue({
      items,
      nextCursor: null,
    });
    vi.mocked(client.getRequirement).mockImplementation((selfUrl) => {
      if (selfUrl === second.links.self) return Promise.resolve(secondDetail);
      firstReads += 1;
      return firstReads === 1
        ? Promise.resolve(firstDetail)
        : lateFirst.promise;
    });
    render(<RequirementWorkbench client={client} />);

    await user.click(
      await screen.findByRole("button", { name: "查看访客预约详情" }),
    );
    await user.click(await screen.findByRole("button", { name: "修订需求" }));
    await user.click(screen.getByRole("button", { name: "保存新版本" }));
    await waitFor(() => expect(firstReads).toBe(2));
    await user.click(screen.getByRole("button", { name: "查看工单审批详情" }));
    const secondCard = screen.getByRole("button", {
      name: "收起工单审批详情",
    }).parentElement!;
    expect(
      (await within(secondCard).findAllByText("工单审批只属于第二个需求"))
        .length,
    ).toBeGreaterThan(0);

    lateFirst.resolve(firstDetail);
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("button", { name: "收起工单审批详情" })
            .parentElement!,
        ).getAllByText("工单审批只属于第二个需求").length,
      ).toBeGreaterThan(0),
    );
    expect(
      within(
        screen.getByRole("button", { name: "收起工单审批详情" }).parentElement!,
      ).queryByText("让访客到访过程更顺畅"),
    ).not.toBeInTheDocument();
  });

  it("修订已提交但详情刷新失败时不诱导重复提交", async () => {
    const user = userEvent.setup();
    const client = createClient();
    const self = items[0]!.links.self;
    const actionUrl = `${self}/revisions`;
    const initial = await client.getRequirement(self);
    vi.mocked(client.listRequirements).mockResolvedValue({
      items: [
        {
          ...items[0]!,
          links: { ...items[0]!.links, actions: { revise: actionUrl } },
        },
      ],
      nextCursor: null,
    });
    vi.mocked(client.getRequirement)
      .mockResolvedValueOnce({
        ...initial,
        links: { ...initial.links, actions: { revise: actionUrl } },
      })
      .mockRejectedValueOnce(new Error("暂时无法读取详情"));
    render(<RequirementWorkbench client={client} />);

    await user.click(
      await screen.findByRole("button", { name: "查看访客预约详情" }),
    );
    await user.click(await screen.findByRole("button", { name: "修订需求" }));
    await user.click(screen.getByRole("button", { name: "保存新版本" }));

    expect(
      await screen.findByText(
        "新版本已保存，但详情刷新失败，请刷新页面查看最新内容",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "修订需求" }),
    ).toBeInTheDocument();
    expect(client.reviseRequirement).toHaveBeenCalledTimes(1);
  });

  it("可展开逐版完整规格比较名称、目标和验收优先级", async () => {
    const user = userEvent.setup();
    const client = createClient();
    const self = items[0]!.links.self;
    const initial = await client.getRequirement(self);
    const oldSpec = {
      ...initial.spec,
      title: "访客预约旧版",
      goal: "只记录访客姓名",
      acceptanceCriteria: [
        {
          title: "记录访客姓名",
          description: "保存姓名即可",
          priority: "should" as const,
        },
      ],
    };
    const currentSpec = {
      ...initial.spec,
      title: "访客预约新版",
      goal: "记录姓名并确认到访时间",
      acceptanceCriteria: [
        {
          title: "确认到访时间",
          description: "业主确认后才生效",
          priority: "must" as const,
        },
      ],
    };
    vi.mocked(client.listRequirements).mockResolvedValue({
      items: [{ ...items[0]!, title: currentSpec.title, version: "第 2 版" }],
      nextCursor: null,
    });
    vi.mocked(client.getRequirement).mockResolvedValue({
      ...initial,
      title: currentSpec.title,
      version: "第 2 版",
      spec: currentSpec,
      revisions: [
        {
          revision: 1,
          version: "第 1 版",
          changedBy: "创建者",
          current: false,
          confirmed: false,
          changes: ["创建需求"],
          contentState: "完整规格",
          spec: oldSpec,
        },
        {
          revision: 2,
          version: "第 2 版",
          changedBy: "需求分析师",
          current: true,
          confirmed: false,
          changes: ["需求名称", "业务目标", "验收标准"],
          contentState: "完整规格",
          spec: currentSpec,
        },
      ],
    });
    render(<RequirementWorkbench client={client} />);

    await user.click(
      await screen.findByRole("button", { name: "查看访客预约新版详情" }),
    );
    const summaries = screen.getAllByText("查看该版完整规格");
    for (const summary of summaries) {
      await user.click(summary);
    }

    expect(summaries[0]!.closest("details")).toHaveTextContent(
      "需求名称：访客预约旧版",
    );
    expect(summaries[0]!.closest("details")).toHaveTextContent(
      "保存姓名即可（应该完成）",
    );
    expect(summaries[1]!.closest("details")).toHaveTextContent(
      "需求名称：访客预约新版",
    );
    expect(summaries[1]!.closest("details")).toHaveTextContent(
      "业主确认后才生效（必须完成）",
    );
  });

  it("新建弹窗支持键盘关闭并把焦点还给原按钮", async () => {
    const user = userEvent.setup();
    render(<RequirementWorkbench client={createClient()} />);
    const opener = screen.getByRole("button", { name: "新建需求" });
    opener.focus();

    await user.click(opener);
    expect(
      screen.getByRole("dialog", { name: "新建需求" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "新建需求" })).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("新建弹窗把背景设为不可操作并把焦点限制在表单内", async () => {
    const user = userEvent.setup();
    render(<RequirementWorkbench client={createClient()} />);
    const opener = screen.getByRole("button", { name: "新建需求" });

    await user.click(opener);
    const close = screen.getByRole("button", { name: "关闭" });
    const save = screen.getByRole("button", { name: "保存并开始整理" });
    expect(opener.closest("main")).toHaveAttribute("inert");
    expect(screen.getByLabelText("需求名称")).toHaveFocus();

    close.focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(save).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
  });

  it("保存过程中锁定关闭入口并限制键盘焦点", async () => {
    const user = userEvent.setup();
    const saved = deferred<void>();
    const client = createClient();
    vi.mocked(client.createRequirement).mockReturnValue(saved.promise);
    render(<RequirementWorkbench client={client} />);

    await user.click(screen.getByRole("button", { name: "新建需求" }));
    await user.type(screen.getByLabelText("需求名称"), "访客预约");
    await user.type(
      screen.getByLabelText("希望解决什么问题？"),
      "让访客可以提前预约",
    );
    await user.type(screen.getByLabelText("怎么才算完成？"), "可以成功提交");
    await user.click(screen.getByRole("button", { name: "保存并开始整理" }));

    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭" })).toBeDisabled();
    await user.keyboard("{Escape}");
    fireEvent.mouseDown(screen.getByTestId("dialog-backdrop"));
    expect(
      screen.getByRole("dialog", { name: "新建需求" }),
    ).toBeInTheDocument();
    expect(client.createRequirement).toHaveBeenCalledTimes(1);

    saved.resolve();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "新建需求" })).toBeNull(),
    );
  });
});
