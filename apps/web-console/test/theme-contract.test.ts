import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const styles = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);

const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)];
const declarations = (selector: string): Record<string, string> =>
  Object.fromEntries(
    rules
      .filter((rule) => rule[1]!.split(",").some((s) => s.trim() === selector))
      .flatMap((rule) =>
        [...rule[2]!.matchAll(/([\w-]+)\s*:\s*([^;]+);/gu)].map((property) => [
          property[1]!,
          property[2]!.trim(),
        ]),
      ),
  );
const contrast = (foreground: string, background: string) => {
  const luminance = (hex: string) => {
    expect(hex).toMatch(/^#[a-f0-9]{6}$/iu);
    const rgb = [1, 3, 5].map((start) => {
      const value = parseInt(hex.slice(start, start + 2), 16) / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
  };
  const a = luminance(foreground),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

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
    const dark = declarations(':root[data-theme="dark"]');
    for (const selector of [
      ".acceptance-heading > span",
      ".card-detail .acceptance-evidence li strong",
    ]) {
      const color = declarations(`:root[data-theme="dark"] ${selector}`).color!;
      for (const background of [dark["--success-soft"]!, dark["--surface"]!])
        expect(contrast(color, background)).toBeGreaterThanOrEqual(4.5);
    }
    expect(declarations(".button.primary")).toMatchObject({
      color: "var(--brand-on)",
      background: "var(--brand)",
    });
    expect(declarations(".button.primary:hover:not(:disabled)")).toMatchObject({
      background: "var(--brand-hover)",
    });
    expect(
      contrast(dark["--brand-on"]!, dark["--brand"]!),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(dark["--brand-on"]!, dark["--brand-hover"]!),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("浅色主操作也保持可读的文字对比度", () => {
    const light = declarations(':root[data-theme="light"]');
    expect(
      contrast(light["--brand-on"]!, light["--brand"]!),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(light["--brand-on"]!, light["--brand-hover"]!),
    ).toBeGreaterThanOrEqual(4.5);
  });
});
