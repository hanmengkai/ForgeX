import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const styles = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);

describe("Web 双主题样式契约", () => {
  it("默认浅色与手动深色主题都由明确的数据属性控制", () => {
    expect(styles).toMatch(/:root(?:,\s*:root\[data-theme="light"\])?\s*\{/);
    expect(styles).toMatch(/:root\[data-theme="dark"\]\s*\{/);
    expect(styles).not.toContain("@media (prefers-color-scheme: dark)");
  });

  it("侧栏、页面背景和卡片统一使用主题变量而不是固定深色块", () => {
    expect(styles).toMatch(
      /\.sidebar\s*\{[\s\S]*?color:\s*var\(--sidebar-ink\);[\s\S]*?background:\s*var\(--sidebar\);/,
    );
    expect(styles).toMatch(
      /body\s*\{[\s\S]*?background:\s*var\(--canvas-background\);/,
    );
    expect(styles).toContain("--sidebar: #f7f9fb;");
  });

  it("桌面内容区使用全部可用宽度", () => {
    expect(styles).toMatch(
      /\.workspace-body\s*\{[^}]*width:\s*100%;[^}]*margin:\s*0;/,
    );
    expect(styles).not.toMatch(
      /\.workspace-body\s*\{[^}]*width:\s*min\(1280px,\s*100%\)/,
    );
  });

  it("深色模式为可信验收标题、结果和主操作提供高对比颜色", () => {
    expect(styles).toMatch(
      /:root\[data-theme="dark"\][\s\S]*\.acceptance-heading > span,[\s\S]*\.card-detail \.acceptance-evidence li strong,[\s\S]*\.acceptance-action \{\s*color: #a9edca;/,
    );
    expect(styles).toMatch(
      /:root\[data-theme="dark"\][\s\S]*\.acceptance-action \{\s*border-color: #4e8b70;/,
    );
  });
});
