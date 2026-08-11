import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const styles = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);

describe("Web 双主题样式契约", () => {
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
      /@media \(prefers-color-scheme: dark\)[\s\S]*\.acceptance-heading > span,[\s\S]*\.card-detail \.acceptance-evidence li strong,[\s\S]*\.acceptance-action \{\s*color: #a9edca;/,
    );
    expect(styles).toMatch(
      /@media \(prefers-color-scheme: dark\)[\s\S]*\.acceptance-action \{\s*border-color: #4e8b70;/,
    );
  });
});
