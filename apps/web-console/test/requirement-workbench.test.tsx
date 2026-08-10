// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

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
      actions: {},
    },
  },
];

const createClient = (): ForgeXClient => ({
  listRequirements: vi.fn().mockResolvedValue({ items, nextCursor: null }),
  listExtensions: vi.fn().mockResolvedValue({
    businessKnowledge: [],
    teamCapabilities: [],
    externalTools: [],
  }),
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
      maxAccounts: 5,
      availableSlots: 3,
    },
  }),
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
  }),
  createRequirement: vi.fn().mockResolvedValue(undefined),
  runRequirementAction: vi.fn().mockResolvedValue(undefined),
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

afterEach(cleanup);

describe("RequirementWorkbench", () => {
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

    await user.click(screen.getByRole("button", { name: "设备中心" }));

    expect(await screen.findByText("2 / 5 个账户已连接")).toBeInTheDocument();
    expect(screen.getByText("研发电脑 1")).toBeInTheDocument();
    expect(screen.getByText("正在处理：访客预约")).toBeInTheDocument();
    expect(screen.getByText("还有 3 个可用槽位")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sessionKey|workerKey|指纹/);
    expect(client.listWorkers).toHaveBeenCalledTimes(1);
  });

  it("扩展中心用业务资料、团队能力和外部工具组织项目能力", async () => {
    const user = userEvent.setup();
    const client = createClient();
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
            self: "/api/v1/extensions/55555555-5555-4555-8555-555555555555",
          },
        },
      ],
    });
    render(<RequirementWorkbench client={client} />);

    await user.click(screen.getByRole("button", { name: "扩展中心" }));

    expect(await screen.findByText("访客业务资料")).toBeInTheDocument();
    expect(screen.getByText("需求风险检查")).toBeInTheDocument();
    expect(screen.getByText("代码仓库工具")).toBeInTheDocument();
    expect(screen.getByText("读取自动放行，变更需要确认")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
    );
    expect(client.listExtensions).toHaveBeenCalledTimes(1);
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
    await user.click(screen.getByRole("button", { name: "保存并开始整理" }));

    expect(client.createRequirement).toHaveBeenCalledWith({
      schemaVersion: 1,
      title: "访客通行记录",
      goal: "让物业人员能够快速查询访客的到访记录",
      userStories: [],
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
      openQuestions: [],
    });
    expect(
      await screen.findByRole("alert", {
        name: "暂时无法保存，请稍后再试",
      }),
    ).toBeInTheDocument();
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
