import { describe, expect, it } from "vitest";

import {
  InMemoryMcpInputSchemaStore,
  MCP_VALIDATOR_CACHE_LIMIT,
  canonicalizeMcpInputSchema,
  mcpValidatorCacheSizeForDiagnostics,
  projectMcpArgumentsForPeople,
  validateMcpToolArguments,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";

const inputSchema = {
  type: "object",
  properties: {
    branchName: {
      title: "分支名称",
      writeOnly: false,
      type: "string",
      minLength: 1,
      maxLength: 80,
    },
    retryCount: {
      title: "重试次数",
      writeOnly: false,
      type: "integer",
      minimum: 0,
      maximum: 3,
      default: 1,
    },
  },
  required: ["branchName"],
  additionalProperties: false,
} as const;

describe("MCP 输入 Schema 制品", () => {
  it("字段顺序不同但语义相同的 Schema 生成相同内容哈希", () => {
    const first = canonicalizeMcpInputSchema(inputSchema);
    const second = canonicalizeMcpInputSchema({
      required: ["branchName"],
      additionalProperties: false,
      properties: {
        retryCount: {
          writeOnly: false,
          title: "重试次数",
          maximum: 3,
          default: 1,
          minimum: 0,
          type: "integer",
        },
        branchName: {
          writeOnly: false,
          title: "分支名称",
          maxLength: 80,
          minLength: 1,
          type: "string",
        },
      },
      type: "object",
    });

    expect(second.hash).toBe(first.hash);
    expect(second.canonicalJson).toBe(first.canonicalJson);
  });

  it("按租户和项目隔离保存，返回副本且同一哈希只能幂等写入", async () => {
    const store = new InMemoryMcpInputSchemaStore();
    const canonical = canonicalizeMcpInputSchema(inputSchema);
    const reference = {
      tenantKey,
      projectKey,
      hashAlgorithm: "sha256" as const,
      hash: canonical.hash,
    };

    await store.put(reference, inputSchema);
    await expect(store.put(reference, inputSchema)).resolves.toBeUndefined();
    const loaded = await store.get(reference);
    expect(loaded).toEqual(inputSchema);
    (loaded as { type: string }).type = "array";
    await expect(store.get(reference)).resolves.toEqual(inputSchema);
    await expect(
      store.get({
        ...reference,
        projectKey: "33333333-3333-4333-8333-333333333333",
      }),
    ).resolves.toBeNull();

    await expect(
      store.put(reference, {
        ...inputSchema,
        required: ["branchName", "retryCount"],
      }),
    ).rejects.toThrow("Schema 内容与登记哈希不一致");
  });

  it("拒绝超大、过深、非对象根节点和带远程引用的 Schema", () => {
    expect(() =>
      canonicalizeMcpInputSchema({
        type: "object",
        description: "x".repeat(70_000),
      }),
    ).toThrow("Schema 不能超过 64 KiB");

    let nested: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < 34; index += 1) {
      nested = { type: "object", properties: { next: nested } };
    }
    expect(() => canonicalizeMcpInputSchema(nested)).toThrow(
      "Schema 结构不能超过 32 层",
    );
    expect(() => canonicalizeMcpInputSchema({ type: "string" })).toThrow(
      "Schema 根节点必须描述一个对象",
    );
    expect(() =>
      canonicalizeMcpInputSchema({
        type: "object",
        properties: {
          input: { $ref: "https://example.test/schema.json" },
        },
      }),
    ).toThrow("Schema 暂不支持引用、组合、正则或格式关键字");
    expect(() =>
      canonicalizeMcpInputSchema({
        type: "object",
        properties: {
          target: {
            type: "string",
            title: "目标内容",
            writeOnly: false,
            pattern: "^(a+)+$",
          },
        },
        additionalProperties: false,
      }),
    ).toThrow("Schema 暂不支持引用、组合、正则或格式关键字");
    expect(() =>
      canonicalizeMcpInputSchema({
        type: "object",
        properties: {
          target: {
            title: "目标内容",
            writeOnly: false,
            anyOf: [{ type: "string" }, { type: "number" }],
          },
        },
        additionalProperties: false,
      }),
    ).toThrow("Schema 暂不支持引用、组合、正则或格式关键字");
  });

  it("规范化时不会让 __proto__ 字段改变对象原型", () => {
    const schemaWithProto = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string","title":"原型字段","writeOnly":false}},"additionalProperties":false}',
    ) as unknown;
    const canonical = canonicalizeMcpInputSchema(schemaWithProto);

    expect(canonical.canonicalJson).toContain('"__proto__"');
    expect(
      Object.prototype.hasOwnProperty.call(
        canonical.schema.properties,
        "__proto__",
      ),
    ).toBe(true);
  });

  it("业务参数可以使用 Schema 保留词作为字段名，但危险关键字与同名标题会被拒绝", () => {
    for (const fieldName of [
      "format",
      "pattern",
      "contains",
      "if",
      "enum",
      "const",
    ]) {
      expect(() =>
        canonicalizeMcpInputSchema({
          type: "object",
          properties: {
            [fieldName]: {
              type: "string",
              title: `业务字段 ${fieldName}`,
              writeOnly: false,
            },
          },
          additionalProperties: false,
        }),
      ).not.toThrow();
    }
    expect(() =>
      canonicalizeMcpInputSchema({
        type: "object",
        properties: {
          source: { type: "string", title: "目标", writeOnly: false },
          destination: { type: "string", title: " 目标 ", writeOnly: false },
        },
        additionalProperties: false,
      }),
    ).toThrow("Schema 参数的业务标题不能重复");
    expect(() =>
      canonicalizeMcpInputSchema({
        type: "object",
        properties: {
          values: {
            type: "array",
            title: "业务列表",
            writeOnly: false,
            items: [{ type: "string", pattern: "^(a+)+$" }],
          },
        },
        additionalProperties: false,
      }),
    ).toThrow("Schema 列表项必须使用单一安全定义");
  });

  it("人工确认投影保留精确空白并逐项展示列表，且限制整项展示预算", () => {
    const schema = {
      type: "object",
      properties: {
        target: { type: "string", title: "部署目标", writeOnly: false },
        branches: {
          type: "array",
          title: "分支列表",
          writeOnly: false,
          items: { type: "string" },
          maxItems: 50,
        },
      },
      required: ["target", "branches"],
      additionalProperties: false,
    };
    expect(
      projectMcpArgumentsForPeople(
        schema,
        { target: "prod  customer", branches: ["A、B", "C"] },
        { requireExactValues: true },
      ),
    ).toEqual([
      {
        label: "分支列表",
        display: "list",
        values: ['"A、B"', '"C"'],
        sensitive: false,
      },
      {
        label: "部署目标",
        display: "single",
        values: ['"prod  customer"'],
        sensitive: false,
      },
    ]);
    expect(() =>
      projectMcpArgumentsForPeople(
        schema,
        { target: "safe", branches: Array(21).fill("y".repeat(400)) },
        { requireExactValues: true },
      ),
    ).toThrow("需要人工确认的业务参数展示内容过多");
  });

  it("严格校验调用参数，不转换类型、不填充默认值并返回中文字段提示", () => {
    const valid = validateMcpToolArguments(inputSchema, {
      branchName: "feature/payment",
    });
    expect(valid).toEqual({ branchName: "feature/payment" });
    expect(valid).not.toHaveProperty("retryCount");

    expect(() =>
      validateMcpToolArguments(inputSchema, {
        branchName: "feature/payment",
        retryCount: "2",
      }),
    ).toThrow(
      expect.objectContaining({
        statusCode: 422,
        code: "mcp_arguments_invalid",
        details: expect.arrayContaining([
          expect.objectContaining({
            field: "retryCount",
            message: "必须是整数",
          }),
        ]),
      }),
    );
    expect(() =>
      validateMcpToolArguments(inputSchema, {
        branchName: "feature/payment",
        hiddenCredential: "should-not-pass",
      }),
    ).toThrow(
      expect.objectContaining({
        details: [
          expect.objectContaining({
            field: "hiddenCredential",
            message: "不支持这个参数",
          }),
        ],
      }),
    );
  });

  it("验证器缓存保持有界并在淘汰后可安全重编译", () => {
    for (let index = 0; index < MCP_VALIDATOR_CACHE_LIMIT + 20; index += 1) {
      validateMcpToolArguments(
        {
          type: "object",
          properties: {
            value: {
              type: "integer",
              title: `业务数值 ${index}`,
              writeOnly: false,
              maximum: index + 1,
            },
          },
          additionalProperties: false,
        },
        { value: 0 },
      );
    }
    expect(mcpValidatorCacheSizeForDiagnostics()).toBeLessThanOrEqual(
      MCP_VALIDATOR_CACHE_LIMIT,
    );
    expect(() =>
      validateMcpToolArguments(inputSchema, { branchName: "feature/retry" }),
    ).not.toThrow();
  });

  it("拒绝在 Schema 文案、默认值和可选值中夹带明文凭据", () => {
    const secret = 'password = "correct horse battery staple"';
    for (const fragment of [
      { description: secret },
      { default: secret },
      { examples: [secret] },
      { enum: [secret] },
      { const: secret },
    ]) {
      expect(() =>
        canonicalizeMcpInputSchema({
          type: "object",
          properties: {
            endpoint: {
              type: "string",
              title: "服务地址",
              writeOnly: false,
              ...fragment,
            },
          },
          additionalProperties: false,
        }),
      ).toThrow("MCP Schema 不能包含明文凭据");
    }
  });
});
