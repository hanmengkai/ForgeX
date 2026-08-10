import { expect, test } from "@playwright/test";

const token = "e2e-access-token-with-enough-entropy";

test("用户登录后刷新仍保持会话，并可安全注销", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "进入你的项目" }),
  ).toBeVisible();

  await page.getByLabel("访问令牌").fill(token);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByText("从第一个业务目标开始")).toBeVisible();
  await expect(page.getByText("端到端产品负责人")).toBeVisible();
  await expect(page.getByLabel("访问令牌")).toHaveCount(0);

  await page.reload();
  await expect(page.getByText("从第一个业务目标开始")).toBeVisible();
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);

  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByLabel("访问令牌")).toBeVisible();
});

test("移动端深色模式可用键盘完成登录且页面不横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");

  await page.getByLabel("访问令牌").focus();
  await page.keyboard.type(token);
  await page.keyboard.press("Enter");
  await expect(page.getByText("从第一个业务目标开始")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
