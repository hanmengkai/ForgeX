import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const styles = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);
const dashboard = readFileSync(
  new URL("../src/dashboard-overview.tsx", import.meta.url),
  "utf8",
);

describe("工作台精致紧凑视觉契约", () => {
  it("压缩侧栏、顶栏和首屏留白，避免傻大粗的方盒子堆叠", () => {
    expect(styles).toMatch(
      /\.app-shell\s*\{[^}]*grid-template-columns:\s*208px minmax\(0, 1fr\);/,
    );
    expect(styles).toMatch(/\.workspace-header\s*\{[^}]*min-height:\s*56px;/);
    expect(styles).toMatch(
      /\.workspace-body\s*\{[^}]*padding:\s*24px 30px 64px;/,
    );
    expect(styles).toMatch(/\.dashboard-overview,[^}]*\{[^}]*gap:\s*16px;/);
    expect(styles).toMatch(
      /\.dashboard-hero\s*\{[^}]*min-height:\s*108px;[^}]*padding:\s*20px 22px;/,
    );
    expect(styles).toMatch(
      /\.dashboard-hero h1\s*\{[^}]*font-size:\s*clamp\(28px, 3vw, 34px\);/,
    );
    expect(styles).toMatch(
      /\.dashboard-card\s*\{[^}]*min-height:\s*154px;[^}]*padding:\s*16px;/,
    );
  });

  it("指标卡使用序号与微状态线建立可扫读的技术细节", () => {
    expect(dashboard.match(/className="dashboard-card-index"/g)).toHaveLength(
      4,
    );
    expect(dashboard.match(/className="dashboard-card-signal"/g)).toHaveLength(
      4,
    );
    expect(styles).toMatch(/\.dashboard-card-index\s*\{/);
    expect(styles).toMatch(/\.dashboard-card-signal\s*\{/);
  });

  it("全局交互控件采用精确的小圆角和紧凑高度", () => {
    expect(styles).toMatch(
      /\.button\s*\{[^}]*min-height:\s*36px;[^}]*border-radius:\s*6px;/,
    );
    expect(styles).toMatch(
      /\.theme-toggle\s*\{[^}]*min-height:\s*32px;[^}]*border-radius:\s*6px;/,
    );
    expect(styles).toMatch(/\.dashboard-card\s*\{[^}]*border-radius:\s*7px;/);
  });

  it("业务页面、配置表单和弹窗共享同一套紧凑视觉尺度", () => {
    expect(styles).toMatch(
      /h1\s*\{[^}]*font-size:\s*clamp\(27px, 3vw, 34px\);/,
    );
    expect(styles).toMatch(
      /\.field input,\s*\.field textarea,\s*\.field select\s*\{[^}]*border-radius:\s*7px;/,
    );
    expect(styles).toMatch(
      /\.fleet-capacity\s*\{[^}]*gap:\s*22px;[^}]*padding:\s*20px 22px;/,
    );
    expect(styles).toMatch(/\.dialog\s*\{[^}]*padding:\s*22px;/);
  });
});
