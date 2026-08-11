import { createHash } from "node:crypto";

import {
  Ajv,
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv";

import { ApplicationError, type ApplicationErrorDetail } from "./errors.js";
import { containsLikelyPlaintextCredential } from "./credential-safety.js";

export interface McpInputSchemaReference {
  tenantKey: string;
  projectKey: string;
  hashAlgorithm: "sha256";
  hash: string;
}

export type McpJsonValue =
  | null
  | string
  | number
  | boolean
  | McpJsonValue[]
  | { [key: string]: McpJsonValue };

export interface CanonicalMcpInputSchema {
  schema: Record<string, unknown>;
  canonicalJson: string;
  hash: string;
  sizeBytes: number;
}

export interface CanonicalMcpArguments {
  arguments: Record<string, McpJsonValue>;
  canonicalJson: string;
  hash: string;
  sizeBytes: number;
}

export interface McpInputSchemaStore {
  put(reference: McpInputSchemaReference, schema: unknown): Promise<void>;
  get(
    reference: McpInputSchemaReference,
  ): Promise<Record<string, unknown> | null>;
}

const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 10_000;
const MAX_ARGUMENT_BYTES = 256 * 1024;
const MAX_ARGUMENT_DEPTH = 32;
const internalKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;
const hiddenControlPattern =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u;

const ajv = new Ajv({
  allErrors: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  strict: true,
  validateFormats: true,
});
const validators = new Map<string, ValidateFunction>();
export const MCP_VALIDATOR_CACHE_LIMIT = 256;
const unsupportedSchemaKeywords = new Set([
  "$ref",
  "$dynamicRef",
  "$recursiveRef",
  "$defs",
  "definitions",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "dependentRequired",
  "contains",
  "unevaluatedItems",
  "unevaluatedProperties",
  "prefixItems",
  "uniqueItems",
  "pattern",
  "patternProperties",
  "propertyNames",
  "format",
]);
const supportedSchemaKeywords = new Set([
  "type",
  "title",
  "description",
  "writeOnly",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "enum",
  "const",
  "default",
  "examples",
]);

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const copyCanonicalJson = (
  value: unknown,
  options: {
    maxDepth: number;
    maxNodes: number;
    rejectExternalReferences: boolean;
  },
  depth = 1,
  state = { nodes: 0 },
): unknown => {
  if (depth > options.maxDepth) {
    throw new Error(
      options.rejectExternalReferences
        ? `Schema 结构不能超过 ${options.maxDepth} 层`
        : `MCP 调用参数不能超过 ${options.maxDepth} 层`,
    );
  }
  state.nodes += 1;
  if (state.nodes > options.maxNodes) {
    throw new Error(
      options.rejectExternalReferences
        ? "Schema 结构过于复杂"
        : "MCP 调用参数过于复杂",
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("JSON 数值必须是有限数字");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      copyCanonicalJson(item, options, depth + 1, state),
    );
  }
  if (!isPlainObject(value)) {
    throw new Error("内容必须是可序列化的 JSON");
  }

  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    if (key.length > 256) throw new Error("JSON 字段名不能超过 256 个字符");
    const item = value[key];
    if (item === undefined) {
      throw new Error("JSON 不能包含 undefined");
    }
    result[key] = copyCanonicalJson(item, options, depth + 1, state);
  }
  return result;
};

const isScalarJson = (value: unknown): boolean =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

const credentialFieldPattern =
  /(?:password|passwd|passphrase|apikey|accesskey|accesstoken|refreshtoken|authtoken|bearertoken|sessiontoken|clientsecret|privatekey|secretkey|credential|credentials)$|^(?:secret|token)$/;
const chineseCredentialPattern =
  /密码|口令|API密钥|访问密钥|访问令牌|刷新令牌|认证令牌|客户端密钥|私钥|凭据/iu;

const assertNotCredentialField = (
  propertyName: string,
  propertySchema: unknown,
): void => {
  const title =
    isPlainObject(propertySchema) && typeof propertySchema.title === "string"
      ? propertySchema.title
      : "";
  for (const value of [propertyName, title]) {
    const compact = value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
    if (
      credentialFieldPattern.test(compact) ||
      chineseCredentialPattern.test(compact)
    ) {
      throw new Error(
        "MCP 参数不能包含密码、令牌、密钥或凭据，认证只能使用客户设备上的本地连接绑定",
      );
    }
  }
};

const assertSupportedSchemaNode = (value: unknown): void => {
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (
      unsupportedSchemaKeywords.has(key) ||
      !supportedSchemaKeywords.has(key)
    ) {
      throw new Error("Schema 暂不支持引用、组合、正则或格式关键字");
    }
    if (
      key === "enum" &&
      (!Array.isArray(item) || item.some((entry) => !isScalarJson(entry)))
    ) {
      throw new Error("Schema 的可选值只能使用文本、数字、是非或空值");
    }
    if (
      key === "enum" &&
      Array.isArray(item) &&
      item.some(
        (entry) =>
          typeof entry === "string" && hiddenControlPattern.test(entry),
      )
    ) {
      throw new Error("Schema 的可选值不能包含隐藏控制字符");
    }
    if (key === "const" && !isScalarJson(item)) {
      throw new Error("Schema 的固定值只能使用文本、数字、是非或空值");
    }
    if (key === "writeOnly" && item !== false) {
      throw new Error(
        "控制面不接受凭据或隐藏参数，请使用客户设备上的本地凭据绑定",
      );
    }
    if (key === "properties" && isPlainObject(item)) {
      for (const [propertyName, propertySchema] of Object.entries(item)) {
        assertNotCredentialField(propertyName, propertySchema);
        assertSupportedSchemaNode(propertySchema);
      }
    } else if (key === "items") {
      if (!isPlainObject(item)) {
        throw new Error("Schema 列表项必须使用单一安全定义");
      }
      assertSupportedSchemaNode(item);
    } else if (key === "additionalProperties" && isPlainObject(item)) {
      assertSupportedSchemaNode(item);
    }
  }
};

const assertNoPlaintextCredentials = (value: unknown): void => {
  if (typeof value === "string") {
    if (containsLikelyPlaintextCredential(value)) {
      throw new ApplicationError(
        422,
        "mcp_credential_detected",
        "MCP Schema 不能包含明文凭据，认证只能使用客户设备上的本地连接绑定",
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertNoPlaintextCredentials);
    return;
  }
  if (!isPlainObject(value)) return;
  Object.values(value).forEach(assertNoPlaintextCredentials);
};

const validatorFor = (
  hash: string,
  schema: Record<string, unknown>,
): ValidateFunction => {
  const existing = validators.get(hash);
  if (existing) {
    validators.delete(hash);
    validators.set(hash, existing);
    return existing;
  }
  const compiled = ajv.compile(schema as AnySchema);
  if (validators.size >= MCP_VALIDATOR_CACHE_LIMIT) {
    const oldest = validators.keys().next().value as string | undefined;
    if (oldest !== undefined) validators.delete(oldest);
  }
  validators.set(hash, compiled);
  return compiled;
};

const parseReference = (
  input: McpInputSchemaReference,
): McpInputSchemaReference => {
  const tenantKey = input.tenantKey.trim().toLowerCase();
  const projectKey = input.projectKey.trim().toLowerCase();
  const hash = input.hash.trim().toLowerCase();
  if (!internalKeyPattern.test(tenantKey)) {
    throw new Error("租户标识格式不正确");
  }
  if (!internalKeyPattern.test(projectKey)) {
    throw new Error("项目标识格式不正确");
  }
  if (input.hashAlgorithm !== "sha256" || !sha256Pattern.test(hash)) {
    throw new Error("Schema 哈希格式不正确");
  }
  return { tenantKey, projectKey, hashAlgorithm: "sha256", hash };
};

export const canonicalizeMcpInputSchema = (
  input: unknown,
): CanonicalMcpInputSchema => {
  const copied = copyCanonicalJson(input, {
    maxDepth: MAX_SCHEMA_DEPTH,
    maxNodes: MAX_SCHEMA_NODES,
    rejectExternalReferences: true,
  });
  if (!isPlainObject(copied) || copied.type !== "object") {
    throw new Error("Schema 根节点必须描述一个对象");
  }
  assertNoPlaintextCredentials(copied);
  const canonicalJson = JSON.stringify(copied);
  const sizeBytes = Buffer.byteLength(canonicalJson, "utf8");
  if (sizeBytes > MAX_SCHEMA_BYTES) {
    throw new Error("Schema 不能超过 64 KiB");
  }
  assertSupportedSchemaNode(copied);
  if (
    copied.additionalProperties !== false ||
    !isPlainObject(copied.properties)
  ) {
    throw new Error("Schema 必须明确列出参数并禁止未声明字段");
  }
  if (Object.keys(copied.properties).length > 50) {
    throw new Error("Schema 参数不能超过 50 项");
  }
  const visibleTitles = new Set<string>();
  for (const [propertyName, propertySchema] of Object.entries(
    copied.properties,
  )) {
    if (
      !isPlainObject(propertySchema) ||
      typeof propertySchema.title !== "string" ||
      propertySchema.title.trim().length < 2 ||
      propertySchema.title.trim().length > 100 ||
      hiddenControlPattern.test(propertySchema.title) ||
      typeof propertySchema.writeOnly !== "boolean"
    ) {
      throw new Error(
        `Schema 参数 ${propertyName} 必须提供业务标题和敏感信息标记`,
      );
    }
    if (/^[a-z][a-z0-9_.-]*$/iu.test(propertySchema.title.trim())) {
      throw new Error("Schema 参数必须使用业务标题，不能直接展示技术字段名");
    }
    const visibleTitle = propertySchema.title
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (visibleTitles.has(visibleTitle)) {
      throw new Error("Schema 参数的业务标题不能重复");
    }
    visibleTitles.add(visibleTitle);
  }
  const hash = createHash("sha256").update(canonicalJson, "utf8").digest("hex");
  try {
    validatorFor(hash, copied);
  } catch {
    throw new Error("Schema 结构不受支持或不完整");
  }
  return {
    schema: copied,
    canonicalJson,
    hash,
    sizeBytes,
  };
};

export const canonicalizeMcpArguments = (
  input: unknown,
): CanonicalMcpArguments => {
  const copied = copyCanonicalJson(input, {
    maxDepth: MAX_ARGUMENT_DEPTH,
    maxNodes: MAX_SCHEMA_NODES,
    rejectExternalReferences: false,
  });
  if (!isPlainObject(copied)) {
    throw new ApplicationError(
      422,
      "mcp_arguments_invalid",
      "MCP 调用参数必须是对象",
      [{ field: "参数", message: "必须是对象", code: "type" }],
    );
  }
  const assertSafeStrings = (value: unknown): void => {
    if (typeof value === "string") {
      if (hiddenControlPattern.test(value)) {
        throw new ApplicationError(
          422,
          "mcp_arguments_unsafe",
          "MCP 调用参数不能包含隐藏控制字符",
        );
      }
      if (containsLikelyPlaintextCredential(value)) {
        throw new ApplicationError(
          422,
          "mcp_credential_detected",
          "MCP 调用参数不能包含明文凭据，请使用设备本地连接绑定",
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(assertSafeStrings);
      return;
    }
    if (isPlainObject(value)) Object.values(value).forEach(assertSafeStrings);
  };
  assertSafeStrings(copied);
  const canonicalJson = JSON.stringify(copied);
  const sizeBytes = Buffer.byteLength(canonicalJson, "utf8");
  if (sizeBytes > MAX_ARGUMENT_BYTES) {
    throw new ApplicationError(
      422,
      "mcp_arguments_too_large",
      "MCP 调用参数不能超过 256 KiB",
    );
  }
  return {
    arguments: copied as Record<string, McpJsonValue>,
    canonicalJson,
    hash: createHash("sha256").update(canonicalJson, "utf8").digest("hex"),
    sizeBytes,
  };
};

const schemaKey = (reference: McpInputSchemaReference): string =>
  `${reference.tenantKey}:${reference.projectKey}:${reference.hash}`;

export class InMemoryMcpInputSchemaStore implements McpInputSchemaStore {
  readonly #schemas = new Map<string, string>();

  async put(
    referenceInput: McpInputSchemaReference,
    schemaInput: unknown,
  ): Promise<void> {
    const reference = parseReference(referenceInput);
    const canonical = canonicalizeMcpInputSchema(schemaInput);
    if (canonical.hash !== reference.hash) {
      throw new Error("Schema 内容与登记哈希不一致");
    }
    const key = schemaKey(reference);
    const existing = this.#schemas.get(key);
    if (existing !== undefined && existing !== canonical.canonicalJson) {
      throw new Error("同一哈希的 Schema 不能被覆盖");
    }
    this.#schemas.set(key, canonical.canonicalJson);
  }

  async get(
    referenceInput: McpInputSchemaReference,
  ): Promise<Record<string, unknown> | null> {
    const reference = parseReference(referenceInput);
    const stored = this.#schemas.get(schemaKey(reference));
    if (stored === undefined) return null;
    const schema: unknown = JSON.parse(stored);
    return canonicalizeMcpInputSchema(schema).schema;
  }
}

const jsonPointerToField = (pointer: string): string => {
  if (!pointer) return "参数";
  const parts = pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  return parts.reduce(
    (path, part) =>
      /^\d+$/.test(part) ? `${path}[${part}]` : path ? `${path}.${part}` : part,
    "",
  );
};

const typeMessage = (type: unknown): string => {
  const messages: Record<string, string> = {
    integer: "必须是整数",
    number: "必须是数字",
    string: "必须是文本",
    boolean: "必须是是或否",
    object: "必须是对象",
    array: "必须是列表",
    null: "必须为空值",
  };
  return typeof type === "string"
    ? (messages[type] ?? "类型不正确")
    : "类型不正确";
};

const errorDetail = (error: ErrorObject): ApplicationErrorDetail => {
  const params = error.params as Record<string, unknown>;
  if (error.keyword === "required") {
    return {
      field: String(params.missingProperty ?? "参数"),
      message: "必须填写",
      code: "required",
    };
  }
  if (error.keyword === "additionalProperties") {
    return {
      field: String(params.additionalProperty ?? "参数"),
      message: "不支持这个参数",
      code: "additional_property",
    };
  }
  const field = jsonPointerToField(error.instancePath);
  const messages: Record<string, string> = {
    minLength: "内容过短",
    maxLength: "内容过长",
    minimum: "数值过小",
    maximum: "数值过大",
    minItems: "选项过少",
    maxItems: "选项过多",
    enum: "不在允许范围内",
    const: "值不正确",
    pattern: "格式不正确",
  };
  return {
    field,
    message:
      error.keyword === "type"
        ? typeMessage(params.type)
        : (messages[error.keyword] ?? "内容不符合要求"),
    code: error.keyword,
  };
};

export const validateMcpToolArguments = (
  schemaInput: unknown,
  argumentsInput: unknown,
): Record<string, McpJsonValue> => {
  const canonical = canonicalizeMcpInputSchema(schemaInput);
  const canonicalArguments = canonicalizeMcpArguments(argumentsInput);
  const copied = JSON.parse(canonicalArguments.canonicalJson) as Record<
    string,
    McpJsonValue
  >;
  const validator = validatorFor(canonical.hash, canonical.schema);
  if (!validator(copied)) {
    throw new ApplicationError(
      422,
      "mcp_arguments_invalid",
      "MCP 调用参数不符合工具要求",
      (validator.errors ?? []).slice(0, 20).map(errorDetail),
    );
  }
  return copied;
};

export interface McpArgumentForPeople {
  label: string;
  display: "single" | "list" | "masked";
  values: string[];
  sensitive: boolean;
}

const humanValue = (value: McpJsonValue, requireExact: boolean): string => {
  if (value === null) return "未填写";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (requireExact && hiddenControlPattern.test(value)) {
      throw new Error("需要人工确认的非敏感文本不能包含隐藏控制字符");
    }
    if (requireExact) {
      const encoded = JSON.stringify(value);
      if (encoded.length > 500) {
        throw new Error("需要人工确认的非敏感文本展示不能超过 500 个字符");
      }
      return encoded;
    }
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > 120
      ? `${normalized.slice(0, 117)}…`
      : normalized;
  }
  if (Array.isArray(value)) {
    if (requireExact) {
      if (!value.every(isScalarJson)) {
        throw new Error("需要人工确认的非敏感列表只能包含简单业务值");
      }
      const exact = value.map((item) => humanValue(item, true)).join("、");
      if (exact.length > 500) {
        throw new Error("需要人工确认的非敏感列表内容过长");
      }
      return exact || "未选择";
    }
    return `已选择 ${value.length} 项`;
  }
  if (requireExact) {
    throw new Error("需要人工确认的非敏感对象必须拆分为清晰的业务字段");
  }
  return `已填写 ${Object.keys(value).length} 项`;
};

export const projectMcpArgumentsForPeople = (
  schemaInput: unknown,
  argumentsInput: unknown,
  options: { requireExactValues?: boolean } = {},
): McpArgumentForPeople[] => {
  const canonicalSchema = canonicalizeMcpInputSchema(schemaInput);
  if (options.requireExactValues === true) {
    const required = new Set(
      Array.isArray(canonicalSchema.schema.required)
        ? canonicalSchema.schema.required.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
    );
    const properties = canonicalSchema.schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    for (const [propertyName, property] of Object.entries(properties)) {
      if (property.writeOnly === true) {
        throw new Error("需要人工确认的调用不能把业务影响字段声明为隐藏凭据");
      }
      if (!required.has(propertyName)) {
        throw new Error("需要人工确认的调用必须明确填写每一项业务参数");
      }
    }
  }
  const argumentsValue = validateMcpToolArguments(
    canonicalSchema.schema,
    argumentsInput,
  );
  const properties = canonicalSchema.schema.properties as Record<
    string,
    Record<string, unknown>
  >;
  const projected = Object.entries(argumentsValue).map(([key, value]) => {
    const property = properties[key];
    if (!property) throw new Error("MCP 参数缺少可信展示定义");
    const sensitive = property.writeOnly === true;
    if (sensitive) {
      return {
        label: String(property.title).trim(),
        display: "masked" as const,
        values: ["已安全提供"],
        sensitive: true,
      };
    }
    if (Array.isArray(value) && options.requireExactValues === true) {
      if (value.length > 50 || !value.every(isScalarJson)) {
        throw new Error("需要人工确认的非敏感列表必须是最多 50 项简单业务值");
      }
      return {
        label: String(property.title).trim(),
        display: "list" as const,
        values: value.map((item) => humanValue(item, true)),
        sensitive: false,
      };
    }
    return {
      label: String(property.title).trim(),
      display: "single" as const,
      values: [humanValue(value, options.requireExactValues === true)],
      sensitive: false,
    };
  });
  if (options.requireExactValues === true) {
    const totalValues = projected.reduce(
      (total, input) => total + input.values.length,
      0,
    );
    const totalCharacters = projected.reduce(
      (total, input) =>
        total +
        input.label.length +
        input.values.reduce((sum, value) => sum + value.length, 0),
      0,
    );
    if (totalValues > 100 || totalCharacters > 8 * 1024) {
      throw new Error("需要人工确认的业务参数展示内容过多");
    }
  }
  return projected;
};

export const mcpValidatorCacheSizeForDiagnostics = (): number =>
  validators.size;
