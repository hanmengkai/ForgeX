import { expect, test, type Page } from "@playwright/test";

const login = async (page: Page, role: string) => {
  await page.goto("/delivery");
  if (await page.getByRole("button", { name: "退出登录" }).count())
    await page.getByRole("button", { name: "退出登录" }).click();
  await page.getByLabel("账号", { exact: true }).fill(`p0.${role}`);
  await page.getByLabel("密码", { exact: true }).fill("P0-Sample-2026!");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "完整交付", exact: true }),
  ).toBeVisible();
};
const approve = async (page: Page) => {
  await expect(page.getByRole("region", { name: "当前审核" })).toBeVisible();
  await page
    .getByLabel("审核意见或处理结论")
    .fill("已核对本轮方案与执行结果，同意进入下一阶段");
  const response = page.waitForResponse(
    (response) =>
      response.url().includes("/decisions") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "审核通过", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(
    page.getByRole("button", { name: "刷新进度", exact: true }),
  ).toBeEnabled();
};

test("六种角色在控制台完成审批与部署、真实预约验收及关闭后 Bug 提交", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(120_000);
  const title = `访客预约界面验收 ${Date.now()}`;
  await login(page, "requester");
  await expect(page.getByRole("link", { name: "设备与 Agent" })).toHaveCount(0);
  await page.getByLabel("需求名称", { exact: true }).fill(title);
  await page
    .getByLabel("业务目标与已有信息")
    .fill("访客提交预约并获得可查询编号，重复提交保持幂等");
  await page.getByRole("button", { name: "提交给需求 AI" }).click();
  const current = page.locator(".lifecycle-stages [aria-current=step]");
  await expect(current).toHaveText("产品审核需求");
  await login(page, "product_owner");
  await approve(page);
  await login(page, "requester");
  await approve(page);
  await expect(current).toHaveText("独立设计审核");
  await expect(
    page.getByRole("button", { name: "审核通过", exact: true }),
  ).toHaveCount(0);
  await login(page, "developer");
  await expect(
    page.getByRole("heading", { name: "设计方案", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("design-review.png"),
    fullPage: true,
  });
  await approve(page);
  await expect(current).toHaveText("研发代码审核");
  await approve(page);
  await login(page, "tester");
  await expect(current).toHaveText("测试报告审核");
  await approve(page);
  await login(page, "test_ops");
  await expect(current).toHaveText("需求方测试环境验收");
  await expect(
    page.getByRole("button", { name: "审核通过", exact: true }),
  ).toHaveCount(0);
  await login(page, "requester");
  await expect(current).toHaveText("需求方测试环境验收");
  const target = await context.newPage();
  const stagingUrl = await page
    .getByRole("link", { name: "打开测试环境", exact: true })
    .getAttribute("href");
  await target.goto(stagingUrl!);
  await target.getByLabel("访客姓名").fill("界面验收访客");
  await target.getByLabel("到访时间").fill("2030-01-01T10:00");
  await target.getByRole("button", { name: "提交预约" }).click();
  await expect(target.locator("output")).toContainText('"id"');
  await target.close();
  await approve(page);
  await expect(current).toHaveText("三方生产放行");
  await approve(page);
  await expect(current).toHaveText("三方生产放行");
  await login(page, "developer");
  await approve(page);
  await login(page, "production_ops");
  await approve(page);
  await expect(current).toHaveText("三方线上验收");
  await approve(page);
  await login(page, "developer");
  await approve(page);
  await login(page, "requester");
  await approve(page);
  await expect(current).toHaveText("已关闭");
  await page.getByLabel("问题名称").fill("预约缺少确认说明");
  await page
    .getByLabel("复现步骤与预期结果")
    .fill("预约提交成功后需要明确显示预约已确认");
  await page.getByRole("button", { name: "提交 Bug", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "关联 Bug", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("closed-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "切换为深色主题" }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("closed-mobile-dark.png"),
    fullPage: true,
  });
});
