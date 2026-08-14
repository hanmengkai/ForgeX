import { expect, test } from "@playwright/test";

const username = "e2e.admin";
const password = "E2E-Password-2026!";
const projectKey = "22222222-2222-4222-8222-222222222222";
const repositoryKey = "33333333-3333-4333-8333-333333333333";
const requirementKey = "77777777-7777-4777-8777-777777777777";
const collection = `/api/v1/projects/${projectKey}/requirements`;
const extensions = `/api/v1/projects/${projectKey}/extensions`;
const self = `${collection}/${requirementKey}`;
const title = "重构手串配置工具的页面视觉样式";

const listItem = {
  title,
  summary: "在保留既有业务行为的前提下重构桌面和手机页面",
  version: "第 2 版",
  status: "已强制终止",
  nextStep: "可以直接重新安排 AI 实现",
  acceptanceProgress: "尚未开始验证",
  links: {
    self,
    history: `${self}/revisions`,
    actions: {
      startDelivery: `${self}/start-delivery`,
      delete: self,
    },
  },
};

const spec = {
  schemaVersion: 1,
  title,
  goal: "在不改变现有配置、搜索、手围、排序、删除、完成与分享等业务行为和既有 DOM ID 的前提下，把已提交的 Web 前台重构为具有东方手作珠宝质感、信息层次清晰，同时适合手机与桌面的页面。",
  userStories: [
    {
      role: "配置工具使用者",
      need: "快速理解当前交付状态并找到下一步操作",
      value: "无需在长页面中反复滚动寻找按钮",
    },
  ],
  acceptanceCriteria: [
    {
      title: "关键操作首屏可达",
      description: "重新安排、修订和删除无需滚动到底部",
      priority: "must",
    },
    {
      title: "长内容保持可扫读",
      description: "阶段名称不逐字换行，日志和版本按需查看",
      priority: "must",
    },
  ],
  openQuestions: [],
};

const detail = {
  ...listItem,
  links: {
    ...listItem.links,
    actions: {
      ...listItem.links.actions,
      revise: `${self}/revisions`,
    },
  },
  spec,
  acceptance: null,
  revisions: [
    {
      revision: 2,
      version: "第 2 版",
      changedBy: "产品负责人",
      current: true,
      confirmed: true,
      changes: ["页面视觉与交互", "移动端布局"],
      contentState: "完整规格",
      spec,
    },
  ],
  progress: {
    percent: 35,
    currentStage: "交付已强制终止",
    updatedAt: "2026-08-14T05:29:21.000Z",
    stages: [
      {
        key: "confirmation",
        label: "需求确认",
        status: "completed",
        detail: "负责人已确认当前需求版本",
      },
      {
        key: "queue",
        label: "设备排队",
        status: "completed",
        detail: "设备曾领取交付任务",
      },
      {
        key: "implementation",
        label: "AI 实现",
        status: "terminated",
        detail: "设备租约已撤销，未提交修改不会进入交付结果",
      },
      {
        key: "commit",
        label: "本地提交",
        status: "pending",
        detail: "等待设备生成本地提交",
      },
      {
        key: "verification",
        label: "独立验证",
        status: "pending",
        detail: "等待独立 Runner 验证",
      },
      {
        key: "acceptance",
        label: "产品验收",
        status: "pending",
        detail: "等待产品负责人体验并验收",
      },
    ],
  },
  executionEvents: [
    {
      title: "Codex 开始分析需求",
      detail: "已进入受控项目工作区",
      tone: "running",
      occurredAt: "2026-08-14T05:29:17.000Z",
    },
    {
      title: "Codex 执行未完成",
      detail: "Codex 登录不可用，请在设备端重新完成登录",
      tone: "error",
      occurredAt: "2026-08-14T05:29:21.000Z",
    },
  ],
};

test("长需求弹窗在桌面和手机上保持可扫读且关键操作始终可达", async ({
  page,
}) => {
  await page.route("**/api/v1/requirement-contexts", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [
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
                        createRequirement: `/api/v1/projects/${projectKey}/repositories/${repositoryKey}/requirements`,
                      },
                    },
                  },
                ],
                links: { requirements: collection, extensions },
              },
            ],
          },
        ],
      }),
    });
  });
  await page.route(`**${extensions}`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          businessKnowledge: [],
          teamCapabilities: [],
          externalTools: [],
        },
      }),
    });
  });
  await page.route(`**${collection}?limit=100`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [listItem], meta: { nextCursor: null } }),
    });
  });
  await page.route(`**${self}`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: detail }),
    });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByLabel("账号").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("link", { name: "需求管理" }).click();
  await page.getByRole("button", { name: `查看${title}详情` }).click();

  const dialog = page.getByRole("dialog", { name: `${title}详情` });
  const actionGroup = dialog.getByRole("group", { name: "需求操作" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("tablist", { name: "需求详情分类" }),
  ).toBeVisible();
  await expect(
    actionGroup.getByRole("button", { name: "重新安排 AI 实现" }),
  ).toBeVisible();

  const dialogBox = await dialog.boundingBox();
  expect(dialogBox?.width).toBeGreaterThanOrEqual(1080);
  expect(
    (dialogBox?.y ?? 900) + (dialogBox?.height ?? 900),
  ).toBeLessThanOrEqual(876);
  const stageWidths = await dialog
    .locator(".delivery-progress-stages li")
    .evaluateAll((items) =>
      items.map((item) => item.getBoundingClientRect().width),
    );
  expect(stageWidths).toHaveLength(6);
  expect(Math.min(...stageWidths)).toBeGreaterThanOrEqual(130);
  await expect(dialog.getByText("已终止于 35%")).toBeVisible();
  await expect(dialog.getByRole("log")).toHaveCount(0);

  await page.screenshot({
    path: "test-results/requirement-dialog-desktop-light.png",
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.screenshot({
    path: "test-results/requirement-dialog-desktop-dark.png",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  await expect(actionGroup).toBeVisible();
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/requirement-dialog-mobile.png",
  });
});
