import { describe, expect, it } from "vitest";

import { SkillPackageCodec } from "../src/index.js";

const content = {
  schemaVersion: 1 as const,
  instructions:
    "# 需求风险检查\n\n先阅读需求与验收标准，再检查遗漏、歧义和高风险变更。",
  resources: [
    {
      path: "references/checklist.md",
      mediaType: "text/markdown" as const,
      encoding: "utf8" as const,
      content: "# 检查项\n\n- 权限边界\n- 数据迁移\n",
    },
    {
      path: "scripts/check.js",
      mediaType: "application/javascript" as const,
      encoding: "utf8" as const,
      content: "export const check = () => true;\n",
    },
  ],
};

describe("SkillPackageCodec", () => {
  it("把 SKILL.md 指令和资源编码为可重现的规范包", () => {
    const reversed = {
      ...content,
      resources: [...content.resources].reverse(),
    };

    const encoded = SkillPackageCodec.encode(reversed);

    expect(encoded).toEqual(SkillPackageCodec.encode(content));
    expect(SkillPackageCodec.decode(encoded)).toEqual(content);
  });

  it("拒绝路径穿越、重复资源、非规范 JSON 和伪 Base64", () => {
    expect(() =>
      SkillPackageCodec.encode({
        ...content,
        resources: [{ ...content.resources[0]!, path: "../secret.txt" }],
      }),
    ).toThrow();
    expect(() =>
      SkillPackageCodec.encode({
        ...content,
        resources: [content.resources[0]!, content.resources[0]!],
      }),
    ).toThrow("Skill 资源路径不能重复");
    expect(() =>
      SkillPackageCodec.decode(
        Buffer.from(JSON.stringify({ ...content, extra: true }), "utf8"),
      ),
    ).toThrow("Skill 包内容格式无效");
    expect(() =>
      SkillPackageCodec.encode({
        ...content,
        resources: [
          {
            path: "assets/logo.bin",
            mediaType: "application/octet-stream",
            encoding: "base64",
            content: "not-base64",
          },
        ],
      }),
    ).toThrow("资源内容不是规范 Base64");
  });
});

describe("SkillPackageCodec 跨平台路径", () => {
  it("拒绝会被文件系统归一化到其他位置的资源路径", () => {
    for (const path of [
      "scripts/a/./run.js",
      "scripts/CON",
      "scripts/run.js.",
      "scripts/run.js ",
    ]) {
      expect(() =>
        SkillPackageCodec.encode({
          ...content,
          resources: [{ ...content.resources[0]!, path }],
        }),
      ).toThrow();
    }

    expect(() =>
      SkillPackageCodec.encode({
        ...content,
        resources: [
          { ...content.resources[0]!, path: "scripts/a/./run.js" },
          { ...content.resources[1]!, path: "scripts/a/run.js" },
        ],
      }),
    ).toThrow();
  });
});
