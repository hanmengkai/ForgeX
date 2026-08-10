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
          }),
        }),
      ),
    );
    const client = createHttpForgeXClient({ fetcher });

    await expect(client.getRequirement(requested)).rejects.toThrow(
      "需求详情与当前需求不匹配",
    );
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
});
