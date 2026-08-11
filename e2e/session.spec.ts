import { expect, test } from "@playwright/test";

const username = "e2e.admin";
const password = "E2E-Password-2026!";

test("用户通过账号密码登录后刷新仍保持会话，并可安全注销", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "登录交付控制台" }),
  ).toBeVisible();

  await page.getByLabel("账号").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(
    page.getByRole("heading", { name: "ForgeX 运行总览" }),
  ).toBeVisible();
  await expect(page.getByText("端到端超级管理员")).toBeVisible();
  await expect(page.getByText(username)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "账号" })).toHaveCount(0);

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "ForgeX 运行总览" }),
  ).toBeVisible();
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);

  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByLabel("账号")).toBeVisible();
});

test("移动端可手动切换深色主题，刷新后保留且页面不横向溢出", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "切换为深色主题" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByLabel("账号").fill(username);
  await page.getByLabel("密码").focus();
  await page.keyboard.type(password);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "ForgeX 运行总览" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByRole("button", { name: "切换为浅色主题" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
