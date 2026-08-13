import { expect, test } from "@playwright/test";

const username = "e2e.admin";
const password = "E2E-Password-2026!";

test("桌面工作台保持紧凑首屏并支持浅深主题", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByLabel("账号").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(
    page.getByRole("heading", { name: "ForgeX 运行总览" }),
  ).toBeVisible();

  const sidebar = await page.locator(".sidebar").boundingBox();
  const header = await page.locator(".workspace-header").boundingBox();
  const hero = await page.locator(".dashboard-hero").boundingBox();
  const firstCard = await page.locator(".dashboard-card").first().boundingBox();
  const foundation = await page.locator(".dashboard-foundation").boundingBox();

  expect(sidebar?.width).toBeLessThanOrEqual(210);
  expect(header?.height).toBeLessThanOrEqual(58);
  expect(hero?.height).toBeLessThanOrEqual(132);
  expect(firstCard?.height).toBeLessThanOrEqual(175);
  expect((foundation?.y ?? 1000) + (foundation?.height ?? 1000)).toBeLessThan(
    820,
  );

  await page.screenshot({
    path: "test-results/theme-light.png",
    fullPage: true,
  });

  await page.getByRole("link", { name: "需求管理" }).click();
  await expect(page.getByRole("heading", { name: "需求管理" })).toBeVisible();
  await page.screenshot({
    path: "test-results/requirements-refined-light.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1137, height: 760 });
  const projectSelect = await page.getByLabel("当前项目").boundingBox();
  const repositoryCount = await page
    .locator(".context-repository-count")
    .boundingBox();
  expect(projectSelect).not.toBeNull();
  expect(repositoryCount).not.toBeNull();
  expect(
    (projectSelect?.x ?? 0) + (projectSelect?.width ?? 0),
  ).toBeLessThanOrEqual(repositoryCount?.x ?? 0);
  await page.screenshot({
    path: "test-results/requirements-1137-no-overlap.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "工作台" }).click();

  await page.getByRole("button", { name: "切换为深色主题" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: "test-results/theme-dark.png",
    fullPage: true,
  });
});
