import { describe, expect, it } from "vitest";

import {
  canonicalizeMcpInputSchema,
  projectMcpArgumentsForPeople,
} from "../src/index.js";

const visibleSchema = (title = "部署目标") => ({
  type: "object",
  properties: {
    target: { type: "string", title, writeOnly: false },
  },
  required: ["target"],
  additionalProperties: false,
});

describe("MCP 人工确认文本安全边界", () => {
  it.each([
    ["password", "业务字段"],
    ["apiKey", "业务字段"],
    ["token", "业务字段"],
    ["value", "登录密码"],
  ])("拒绝明文凭据字段 %s / %s 进入控制面", (propertyName, title) => {
    expect(() =>
      canonicalizeMcpInputSchema({
        type: "object",
        properties: {
          [propertyName]: { type: "string", title, writeOnly: false },
        },
        required: [propertyName],
        additionalProperties: false,
      }),
    ).toThrow(
      "MCP 参数不能包含密码、令牌、密钥或凭据，认证只能使用客户设备上的本地连接绑定",
    );
  });

  it("允许明确不是凭据的分页游标业务字段", () => {
    expect(() =>
      canonicalizeMcpInputSchema({
        type: "object",
        properties: {
          pageToken: {
            type: "string",
            title: "分页游标",
            writeOnly: false,
          },
        },
        required: ["pageToken"],
        additionalProperties: false,
      }),
    ).not.toThrow();
  });

  it("拒绝字段标题和值中的双向与零宽控制字符", () => {
    expect(() =>
      canonicalizeMcpInputSchema(visibleSchema("安全\u202Ecod.exe")),
    ).toThrow("Schema 参数 target 必须提供业务标题和敏感信息标记");
    expect(() =>
      projectMcpArgumentsForPeople(
        visibleSchema(),
        { target: "safe.txt\u202Ecod.exe" },
        { requireExactValues: true },
      ),
    ).toThrow("需要人工确认的非敏感文本不能包含隐藏控制字符");
    expect(() =>
      projectMcpArgumentsForPeople(
        visibleSchema(),
        { target: "customer\u200Badmin" },
        { requireExactValues: true },
      ),
    ).toThrow("需要人工确认的非敏感文本不能包含隐藏控制字符");
  });

  it("按最终 JSON 展示文本限制长度，避免转义后越过 Web 契约", () => {
    expect(
      projectMcpArgumentsForPeople(
        visibleSchema(),
        { target: "x".repeat(498) },
        { requireExactValues: true },
      )[0]?.values[0],
    ).toHaveLength(500);
    expect(() =>
      projectMcpArgumentsForPeople(
        visibleSchema(),
        { target: "x".repeat(499) },
        { requireExactValues: true },
      ),
    ).toThrow("需要人工确认的非敏感文本展示不能超过 500 个字符");
    expect(() =>
      projectMcpArgumentsForPeople(
        visibleSchema(),
        { target: '"'.repeat(300) },
        { requireExactValues: true },
      ),
    ).toThrow("需要人工确认的非敏感文本展示不能超过 500 个字符");
  });

  it("人工确认不能由扩展用 writeOnly 隐藏副作用参数", () => {
    expect(() =>
      projectMcpArgumentsForPeople(
        {
          type: "object",
          properties: {
            target: {
              type: "string",
              title: "付款账户",
              writeOnly: true,
            },
          },
          required: ["target"],
          additionalProperties: false,
        },
        { target: "customer-A" },
        { requireExactValues: true },
      ),
    ).toThrow("控制面不接受凭据或隐藏参数，请使用客户设备上的本地凭据绑定");
  });

  it("人工确认要求副作用参数全部显式填写，不采用隐藏的默认行为", () => {
    expect(() =>
      projectMcpArgumentsForPeople(
        {
          type: "object",
          properties: {
            target: {
              type: "string",
              title: "部署环境",
              writeOnly: false,
              default: "production",
            },
          },
          additionalProperties: false,
        },
        {},
        { requireExactValues: true },
      ),
    ).toThrow("需要人工确认的调用必须明确填写每一项业务参数");
  });
});
