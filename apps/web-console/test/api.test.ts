import { describe, expect, it, vi } from "vitest";

import { createHttpForgeXClient } from "../src/index.js";

describe("createHttpForgeXClient", () => {
  const requirement = (overrides: Record<string, unknown> = {}) => ({
    title: "访客预约",
    summary: "让访客到访过程更顺畅",
    version: "第 1 版",
    status: "正在整理",
    nextStep: "完善内容后提交确认",
    acceptanceProgress: "尚未开始验证",
    links: {
      self: "/api/v1/requirements/33333333-3333-4333-8333-333333333333",
      actions: {},
    },
    ...overrides,
  });

  it("使用同源会话并读取服务端的人性化错误", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: "登录信息已失效，请重新登录" },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const client = createHttpForgeXClient({
      authorization: "Bearer development-session",
      fetcher,
    });

    await expect(client.listRequirements()).rejects.toThrow(
      "登录信息已失效，请重新登录",
    );
    const request = fetcher.mock.calls[0]!;
    expect(request[0]).toBe("/api/v1/requirements?limit=100");
    expect(request[1]).toMatchObject({ credentials: "include" });
    expect(new Headers(request[1]?.headers).get("Authorization")).toBe(
      "Bearer development-session",
    );
  });

  it("拒绝执行服务端需求资源之外的链接", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createHttpForgeXClient({ fetcher });

    await expect(
      client.runRequirementAction("https://attacker.example/action", {}),
    ).rejects.toThrow("这个操作已经失效");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("拒绝伪装成需求动作的路径穿越链接", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createHttpForgeXClient({ fetcher });

    await expect(
      client.runRequirementAction(
        "/api/v1/requirements/33333333-3333-4333-8333-333333333333/../../workers",
        {},
      ),
    ).rejects.toThrow("这个操作已经失效");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("列表响应损坏时不把未知数据直接交给页面", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: [{}], meta: { nextCursor: null } }),
        ),
      );
    const client = createHttpForgeXClient({ fetcher });

    await expect(client.listRequirements()).rejects.toThrow(
      "需求列表格式不正确",
    );
  });

  it("扩展目录严格绑定三类入口并拒绝敏感字段", async () => {
    const valid = {
      name: "代码仓库工具",
      summary: "读取代码、创建交付分支并运行受控检查",
      status: "可使用",
      detail: "3 项业务能力",
      supportingText: "读取自动放行，变更需要确认",
      links: {
        self: "/api/v1/extensions/mcp/33333333-3333-4333-8333-333333333333",
      },
    };
    const businessKnowledge = {
      ...valid,
      name: "访客业务资料",
      links: {
        self: "/api/v1/extensions/55555555-5555-4555-8555-555555555555",
      },
    };
    const trustedSkill = {
      ...valid,
      name: "需求风险检查",
      links: {
        self: "/api/v1/extensions/skills/44444444-4444-4444-8444-444444444444",
      },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              businessKnowledge: [businessKnowledge],
              teamCapabilities: [trustedSkill],
              externalTools: [valid],
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              businessKnowledge: [],
              teamCapabilities: [],
              externalTools: [{ ...valid, sessionKey: "do-not-leak" }],
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              businessKnowledge: [],
              teamCapabilities: [],
              externalTools: [trustedSkill],
            },
          }),
        ),
      );
    const client = createHttpForgeXClient({ fetcher });

    await expect(client.listExtensions()).resolves.toEqual({
      businessKnowledge: [businessKnowledge],
      teamCapabilities: [trustedSkill],
      externalTools: [valid],
    });
    await expect(client.listExtensions()).rejects.toThrow("扩展目录格式不正确");
    await expect(client.listExtensions()).rejects.toThrow("扩展目录格式不正确");
  });

  it("接受与需求契约一致的 150 字标题边界", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [requirement({ title: "需".repeat(150) })],
          meta: { nextCursor: null },
        }),
      ),
    );
    const client = createHttpForgeXClient({ fetcher });

    await expect(client.listRequirements()).resolves.toMatchObject({
      items: [{ title: "需".repeat(150) }],
    });
  });

  it("拒绝把其他需求的详情显示在当前卡片下", async () => {
    const requested =
      "/api/v1/requirements/33333333-3333-4333-8333-333333333333";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: requirement({
            links: {
              self: "/api/v1/requirements/44444444-4444-4444-8444-444444444444",
              actions: {},
            },
            spec: {
              schemaVersion: 1,
              title: "其他需求",
              goal: "不应展示在当前卡片下",
              userStories: [],
              acceptanceCriteria: [],
              openQuestions: [],
            },
            acceptance: null,
          }),
        }),
      ),
    );
    const client = createHttpForgeXClient({ fetcher });

    await expect(client.getRequirement(requested)).rejects.toThrow(
      "需求详情与当前需求不匹配",
    );
  });

  it("拒绝状态与可信验收结果互相矛盾的详情", async () => {
    const self = "/api/v1/requirements/33333333-3333-4333-8333-333333333333";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: requirement({
            status: "等待产品验收",
            links: { self, actions: { accept: `${self}/accept` } },
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
        }),
      ),
    );
    const client = createHttpForgeXClient({ fetcher });

    await expect(client.getRequirement(self)).rejects.toThrow(
      "需求详情格式不正确",
    );
  });

  it("拒绝把当前需求之外的 Preview 链接交给页面打开", async () => {
    const self = "/api/v1/requirements/33333333-3333-4333-8333-333333333333";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: requirement({
            status: "等待产品验收",
            links: {
              self,
              preview: "/api/v1/workers",
              actions: { accept: `${self}/accept` },
            },
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
          }),
        }),
      ),
    );
    const client = createHttpForgeXClient({ fetcher });

    await expect(client.getRequirement(self)).rejects.toThrow(
      "需求详情格式不正确",
    );
  });

  it("只接受与详情 self 精确绑定的同源 Preview 链接", async () => {
    const self = "/api/v1/requirements/33333333-3333-4333-8333-333333333333";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: requirement({
            status: "等待产品验收",
            links: {
              self,
              preview: `${self}/preview`,
              actions: { accept: `${self}/accept` },
            },
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
          }),
        }),
      ),
    );
    const client = createHttpForgeXClient({ fetcher });

    await expect(client.getRequirement(self)).resolves.toMatchObject({
      links: { self, preview: `${self}/preview` },
    });
  });

  it("Cookie 会话执行写操作时附带同源请求保护头", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 201 }));
    const client = createHttpForgeXClient({ fetcher });

    await client.createRequirement({
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
    });

    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-ForgeX-CSRF")).toBe("1");
  });

  it("设备列表损坏时不向页面泄漏未知运行时数据", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ deviceName: "研发电脑", sessionKey: "secret" }],
          meta: { connectedAccounts: 1, maxAccounts: 5, availableSlots: 4 },
        }),
      ),
    );
    const client = createHttpForgeXClient({ fetcher });

    await expect(client.listWorkers()).rejects.toThrow("设备列表格式不正确");
  });

  it("严格校验操作确认列表并只执行与当前操作精确绑定的确认入口", async () => {
    const self = "/api/v1/mcp-invocations/33333333-3333-4333-8333-333333333333";
    const valid = {
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
      ],
      links: {
        self,
        actions: {
          approve: `${self}/approve`,
          cancel: `${self}/cancel`,
        },
      },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [valid] })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ ...valid, technicalName: "unsafe.tool" }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                ...valid,
                inputs: [
                  {
                    label: "访问凭据",
                    display: "masked",
                    values: ["real-secret"],
                    sensitive: true,
                  },
                ],
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const client = createHttpForgeXClient({ fetcher });

    await expect(client.listMcpInvocations()).resolves.toEqual([valid]);
    await expect(client.listMcpInvocations()).rejects.toThrow(
      "操作确认列表格式不正确",
    );
    await expect(client.listMcpInvocations()).rejects.toThrow(
      "操作确认列表格式不正确",
    );
    await expect(
      client.approveMcpInvocation("/api/v1/mcp-invocations/../../../workers"),
    ).rejects.toThrow("这项确认已经失效");
    await expect(client.cancelMcpInvocation(`${self}/approve`)).rejects.toThrow(
      "这项取消操作已经失效",
    );
    await client.approveMcpInvocation(`${self}/approve`);
    expect(fetcher.mock.calls[3]?.[0]).toBe(`${self}/approve`);
    expect(fetcher.mock.calls[3]?.[1]).toMatchObject({ method: "POST" });
    await client.cancelMcpInvocation(`${self}/cancel`);
    expect(fetcher.mock.calls[4]?.[0]).toBe(`${self}/cancel`);
    expect(fetcher.mock.calls[4]?.[1]).toMatchObject({ method: "POST" });
  });
});
