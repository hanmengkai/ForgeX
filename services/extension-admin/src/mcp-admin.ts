import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import path from "node:path";

import {
  assertMcpManifestContainsNoCredential,
  canonicalizeMcpInputSchema,
} from "@forgex/application";
import {
  DeviceMcpConnectionSchema,
  canonicalMcpServerIdentityHash,
  probeLocalMcpConnection,
} from "@forgex/device-worker";
import {
  McpHealthAuthority,
  McpServerManifestSchema,
  SignedMcpHealthAttestationSchema,
} from "@forgex/extensions";
import { z } from "zod";

import {
  createPrivateFile,
  defaultAssertPrivatePath,
  parseJson,
  readPrivateText,
  type PrivatePathCheck,
} from "./private-files.js";
import {
  ExtensionAdminConfigSchema,
  loadExtensionAdminConfig,
} from "./skill-admin.js";

const internalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const technicalName = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u);

const McpReleaseToolInputSchema = z
  .object({
    toolKey: internalKey.optional(),
    technicalName,
    displayName: z.string().trim().min(2).max(100),
    description: z.string().trim().min(4).max(500),
    effect: z.enum(["read", "write", "external_action"]),
    approval: z.enum(["automatic", "review_required"]),
  })
  .strict();

export const McpReleaseInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    serverKey: internalKey.optional(),
    revision: z.number().int().min(1).max(20),
    name: z.string().trim().min(2).max(100),
    summary: z.string().trim().min(4).max(500),
    connection: DeviceMcpConnectionSchema,
    tools: z.array(McpReleaseToolInputSchema).min(1).max(50),
  })
  .strict()
  .superRefine((release, context) => {
    if (release.revision > 1 && !release.serverKey) {
      context.addIssue({
        code: "custom",
        path: ["serverKey"],
        message: "MCP 后续修订必须沿用原服务标识",
      });
    }
    release.tools.forEach((tool, index) => {
      if (release.revision > 1 && !tool.toolKey) {
        context.addIssue({
          code: "custom",
          path: ["tools", index, "toolKey"],
          message: "MCP 后续修订必须沿用原工具标识",
        });
      }
    });
    const names = release.tools.map((tool) => tool.technicalName);
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: "custom",
        path: ["tools"],
        message: "MCP 发布输入不能包含重复工具",
      });
    }
  });

const McpInputSchemaBundleItemSchema = z
  .object({
    toolKey: internalKey,
    schema: z.record(z.string(), z.unknown()),
  })
  .strict();

export const PreparedMcpReleaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    manifest: McpServerManifestSchema,
    inputSchemas: z.array(McpInputSchemaBundleItemSchema).min(1).max(50),
    health: SignedMcpHealthAttestationSchema,
  })
  .strict();

export type PreparedMcpRelease = z.infer<typeof PreparedMcpReleaseSchema>;

export const PreparedMcpHealthRefreshSchema = z
  .object({
    schemaVersion: z.literal(1),
    health: SignedMcpHealthAttestationSchema,
  })
  .strict();

export type PreparedMcpHealthRefresh = z.infer<
  typeof PreparedMcpHealthRefreshSchema
>;
type ExtensionAdminConfig = z.infer<typeof ExtensionAdminConfigSchema>;
type FetchLike = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

const canonicalizeObservedSchema = (
  input: unknown,
): ReturnType<typeof canonicalizeMcpInputSchema> => {
  try {
    return canonicalizeMcpInputSchema(input);
  } catch {
    throw new Error(
      "MCP 实际 Schema 不符合可信发布边界，可能包含明文凭据或不受支持结构",
    );
  }
};

const parsePreparedMcpRelease = (input: unknown): PreparedMcpRelease => {
  const bundle = PreparedMcpReleaseSchema.parse(input);
  assertMcpManifestContainsNoCredential(bundle.manifest);
  const schemas = new Map(
    bundle.inputSchemas.map((item) => [item.toolKey, item]),
  );
  if (
    schemas.size !== bundle.inputSchemas.length ||
    schemas.size !== bundle.manifest.tools.length
  ) {
    throw new Error("MCP 发布包的工具与 Schema 不是一一对应关系");
  }
  const observed = new Map(
    bundle.health.payload.observedTools.map((tool) => [
      tool.technicalName,
      tool,
    ]),
  );
  for (const tool of bundle.manifest.tools) {
    const item = schemas.get(tool.toolKey);
    if (!item) throw new Error("MCP 发布包缺少工具 Schema");
    const canonical = canonicalizeMcpInputSchema(item.schema);
    if (
      canonical.hash !== tool.inputSchemaHash ||
      JSON.stringify(canonical.schema) !== JSON.stringify(item.schema)
    ) {
      throw new Error("MCP 发布包的工具 Schema 与摘要不一致");
    }
    const healthTool = observed.get(tool.technicalName);
    if (
      !healthTool ||
      healthTool.inputSchemaHash !== canonical.hash ||
      healthTool.inputSchemaHashAlgorithm !== "sha256"
    ) {
      throw new Error("MCP 健康证明与实际工具 Schema 不一致");
    }
  }
  const payload = bundle.health.payload;
  if (
    observed.size !== bundle.manifest.tools.length ||
    payload.tenantKey !== bundle.manifest.tenantKey ||
    payload.projectKey !== bundle.manifest.projectKey ||
    payload.serverKey !== bundle.manifest.serverKey ||
    payload.serverRevision !== bundle.manifest.revision ||
    payload.manifestHash !== McpHealthAuthority.manifestHash(bundle.manifest) ||
    payload.protocolVersion !== bundle.manifest.protocolVersion ||
    payload.status !== "healthy" ||
    payload.probeSequence !== 1 ||
    payload.previousAttestationKey !== null ||
    payload.recoveryChallengeKey !== null
  ) {
    throw new Error("MCP 健康证明与发布清单绑定不一致");
  }
  return bundle;
};

const assertReleaseScope = (
  bundle: PreparedMcpRelease,
  config: ExtensionAdminConfig,
): void => {
  if (
    bundle.manifest.tenantKey !== config.scope.tenantKey ||
    bundle.manifest.projectKey !== config.scope.projectKey ||
    bundle.health.payload.verifierKey !== config.mcpVerifier.verifierKey ||
    bundle.health.payload.keyId !== config.mcpVerifier.keyId
  ) {
    throw new Error("MCP 发布包与扩展管理范围或探测身份不一致");
  }
};

const assertHealthScope = (
  health: PreparedMcpHealthRefresh["health"],
  config: ExtensionAdminConfig,
): void => {
  if (
    health.payload.tenantKey !== config.scope.tenantKey ||
    health.payload.projectKey !== config.scope.projectKey ||
    health.payload.verifierKey !== config.mcpVerifier.verifierKey ||
    health.payload.keyId !== config.mcpVerifier.keyId
  ) {
    throw new Error("MCP 健康续期与扩展管理范围或探测身份不一致");
  }
};

const assertHealthSignature = (
  health: PreparedMcpHealthRefresh["health"],
  privateKey: ReturnType<typeof createPrivateKey>,
): void => {
  if (
    !verify(
      null,
      Buffer.from(McpHealthAuthority.canonicalPayload(health.payload), "utf8"),
      createPublicKey(privateKey),
      Buffer.from(health.signature, "base64"),
    )
  ) {
    throw new Error("MCP 健康证明签名无效");
  }
};

const parsePreparedMcpHealthRefresh = (
  input: unknown,
): PreparedMcpHealthRefresh => PreparedMcpHealthRefreshSchema.parse(input);

export const prepareMcpRelease = async (
  input: z.input<typeof McpReleaseInputSchema>,
  options: {
    configPath: string;
    outputPath: string;
    probe?: typeof probeLocalMcpConnection;
    clock?: () => Date;
    assertPrivatePath?: PrivatePathCheck;
  },
): Promise<PreparedMcpRelease> => {
  const release = McpReleaseInputSchema.parse(input);
  const check = options.assertPrivatePath ?? defaultAssertPrivatePath;
  const config = await loadExtensionAdminConfig(options.configPath, check);
  const probe = options.probe ?? probeLocalMcpConnection;
  const result = await probe(release.connection);
  const configuredNames = release.tools
    .map((tool) => tool.technicalName)
    .sort();
  const observedNames = result.tools.map((tool) => tool.technicalName).sort();
  if (JSON.stringify(configuredNames) !== JSON.stringify(observedNames)) {
    throw new Error("MCP 业务工具元数据与本地实际工具清单不一致");
  }
  const canonicalByName = new Map(
    result.tools.map((tool) => [
      tool.technicalName,
      canonicalizeObservedSchema(tool.inputSchema),
    ]),
  );
  const serverKey = release.serverKey ?? randomUUID();
  const publishedAt = (options.clock ?? (() => new Date()))().toISOString();
  const manifest = McpServerManifestSchema.parse({
    schemaVersion: 1,
    serverKey,
    tenantKey: config.scope.tenantKey,
    projectKey: config.scope.projectKey,
    revision: release.revision,
    name: release.name,
    summary: release.summary,
    transport: release.connection.transport,
    connectionBindingKey: release.connection.connectionBindingKey,
    protocolVersion: result.protocolVersion,
    tools: release.tools.map((tool) => {
      const canonical = canonicalByName.get(tool.technicalName);
      if (!canonical) throw new Error("MCP 探测结果缺少已配置工具");
      return {
        ...tool,
        toolKey: tool.toolKey ?? randomUUID(),
        inputSchemaHashAlgorithm: "sha256" as const,
        inputSchemaHash: canonical.hash,
      };
    }),
    publishedAt,
  });
  assertMcpManifestContainsNoCredential(manifest);
  const inputSchemas = manifest.tools.map((tool) => {
    const canonical = canonicalByName.get(tool.technicalName);
    if (!canonical) throw new Error("MCP 探测结果缺少已配置工具");
    return { toolKey: tool.toolKey, schema: canonical.schema };
  });
  const payload = {
    schemaVersion: 1 as const,
    attestationKey: randomUUID(),
    probeSequence: 1,
    previousAttestationKey: null,
    tenantKey: config.scope.tenantKey,
    projectKey: config.scope.projectKey,
    serverKey: manifest.serverKey,
    serverRevision: manifest.revision,
    manifestHashAlgorithm: "sha256" as const,
    manifestHash: McpHealthAuthority.manifestHash(manifest),
    verifierKey: config.mcpVerifier.verifierKey,
    keyId: config.mcpVerifier.keyId,
    serverIdentityHashAlgorithm: "sha256" as const,
    serverIdentityHash: canonicalMcpServerIdentityHash(result.serverIdentity),
    protocolVersion: result.protocolVersion,
    observedTools: manifest.tools.map((tool) => ({
      technicalName: tool.technicalName,
      inputSchemaHashAlgorithm: "sha256" as const,
      inputSchemaHash: tool.inputSchemaHash,
    })),
    status: "healthy" as const,
    recoveryChallengeKey: null,
    producedAt: publishedAt,
  };
  const privateKey = createPrivateKey(
    await readPrivateText(config.mcpVerifierPrivateKeyPath, 32_768, check),
  );
  const health = SignedMcpHealthAttestationSchema.parse({
    payload,
    signature: sign(
      null,
      Buffer.from(McpHealthAuthority.canonicalPayload(payload), "utf8"),
      privateKey,
    ).toString("base64"),
  });
  const bundle = parsePreparedMcpRelease({
    schemaVersion: 1,
    manifest,
    inputSchemas,
    health,
  });
  assertReleaseScope(bundle, config);
  await createPrivateFile(
    path.resolve(options.outputPath),
    `${JSON.stringify(bundle, null, 2)}\n`,
    check,
  );
  return bundle;
};

const RESPONSE_LIMIT_BYTES = 1_048_576;

const readBoundedResponse = async (response: Response): Promise<string> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > RESPONSE_LIMIT_BYTES) {
    throw new Error("控制面响应超过扩展管理协议上限");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) {
        await reader.cancel("response_too_large");
        throw new Error("控制面响应超过扩展管理协议上限");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
};

const sessionKey = z
  .string()
  .trim()
  .min(16)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/u);

const requestControlPlane = async (options: {
  config: ExtensionAdminConfig;
  token: string;
  fetcher: FetchLike;
  method: "GET" | "POST";
  pathname: string;
  body?: unknown;
  expectedStatus: number;
}): Promise<{ response: Response; text: string }> => {
  try {
    const response = await options.fetcher(
      `${options.config.controlPlaneUrl}${options.pathname}`,
      {
        method: options.method,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: "application/json",
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(options.config.requestTimeoutMs),
      },
    );
    const text = await readBoundedResponse(response);
    if (response.status !== options.expectedStatus) {
      throw new Error("unexpected_status");
    }
    return { response, text };
  } catch {
    throw new Error("MCP 扩展管理请求未完成，请使用同一个发布包安全重试");
  }
};

const parseHealthOutcome = (
  text: string,
  expectedProbeSequence: number,
  expectedAttestationKey: string,
): { recoveryChallengeKey: string | null } => {
  try {
    const outcome = z
      .object({
        data: z
          .object({
            recoveryChallengeKey: internalKey.nullable(),
            nextProbeSequence: z
              .number()
              .int()
              .positive()
              .max(Number.MAX_SAFE_INTEGER),
            previousAttestationKey: internalKey,
          })
          .strict(),
      })
      .strict()
      .parse(JSON.parse(text) as unknown);
    if (
      outcome.data.nextProbeSequence !== expectedProbeSequence ||
      outcome.data.previousAttestationKey !== expectedAttestationKey
    ) {
      throw new Error("mcp_health_chain_mismatch");
    }
    return { recoveryChallengeKey: outcome.data.recoveryChallengeKey };
  } catch {
    throw new Error("控制面返回了无效的 MCP 健康链结果");
  }
};

const parseProbeBinding = (
  text: string,
): {
  probeSequence: number;
  previousAttestationKey: string | null;
  recoveryChallengeKey: string | null;
} => {
  try {
    return z
      .object({
        data: z
          .object({
            probeSequence: z
              .number()
              .int()
              .positive()
              .max(Number.MAX_SAFE_INTEGER),
            previousAttestationKey: internalKey.nullable(),
            recoveryChallengeKey: internalKey.nullable(),
          })
          .strict(),
      })
      .strict()
      .parse(JSON.parse(text) as unknown).data;
  } catch {
    throw new Error("控制面返回了无效的 MCP 探测链绑定");
  }
};

export const prepareMcpHealthRefresh = async (
  input: z.input<typeof McpReleaseInputSchema>,
  options: {
    configPath: string;
    sourceBundle: PreparedMcpRelease;
    outputPath: string;
    probe?: typeof probeLocalMcpConnection;
    fetcher?: FetchLike;
    clock?: () => Date;
    assertPrivatePath?: PrivatePathCheck;
  },
): Promise<PreparedMcpHealthRefresh> => {
  const release = McpReleaseInputSchema.parse(input);
  const source = parsePreparedMcpRelease(options.sourceBundle);
  const check = options.assertPrivatePath ?? defaultAssertPrivatePath;
  const config = await loadExtensionAdminConfig(options.configPath, check);
  assertReleaseScope(source, config);
  const manifest = source.manifest;
  if (
    (release.serverKey && release.serverKey !== manifest.serverKey) ||
    release.revision !== manifest.revision ||
    release.connection.transport !== manifest.transport ||
    release.connection.connectionBindingKey !== manifest.connectionBindingKey ||
    JSON.stringify(release.tools.map((tool) => tool.technicalName).sort()) !==
      JSON.stringify(manifest.tools.map((tool) => tool.technicalName).sort())
  ) {
    throw new Error("MCP 续期输入与原始可信发布包不一致");
  }
  for (const tool of release.tools) {
    const sourceTool = manifest.tools.find(
      (candidate) => candidate.technicalName === tool.technicalName,
    );
    if (tool.toolKey && sourceTool?.toolKey !== tool.toolKey) {
      throw new Error("MCP 续期输入与原始可信工具标识不一致");
    }
  }
  const privateKey = createPrivateKey(
    await readPrivateText(config.mcpVerifierPrivateKeyPath, 32_768, check),
  );
  assertHealthSignature(source.health, privateKey);
  const token = sessionKey.parse(
    await readPrivateText(config.administratorSessionKeyPath, 1_024, check),
  );
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const bindingResponse = await requestControlPlane({
    config,
    token,
    fetcher,
    method: "GET",
    pathname: `/api/v1/extensions/mcp/${manifest.serverKey}/revisions/${manifest.revision}/probe-binding`,
    expectedStatus: 200,
  });
  const binding = parseProbeBinding(bindingResponse.text);
  const probe = options.probe ?? probeLocalMcpConnection;
  const result = await probe(release.connection);
  const identityHash = canonicalMcpServerIdentityHash(result.serverIdentity);
  if (
    result.protocolVersion !== manifest.protocolVersion ||
    identityHash !== source.health.payload.serverIdentityHash
  ) {
    throw new Error("MCP 实际协议或服务身份与原始可信发布不一致");
  }
  const observedByName = new Map(
    result.tools.map((tool) => [
      tool.technicalName,
      canonicalizeObservedSchema(tool.inputSchema),
    ]),
  );
  if (observedByName.size !== manifest.tools.length) {
    throw new Error("MCP 实际工具集合与原始可信发布不一致");
  }
  const observedTools = manifest.tools.map((tool) => {
    const observed = observedByName.get(tool.technicalName);
    if (!observed || observed.hash !== tool.inputSchemaHash) {
      throw new Error("MCP 实际工具 Schema 与原始可信发布不一致");
    }
    return {
      technicalName: tool.technicalName,
      inputSchemaHashAlgorithm: "sha256" as const,
      inputSchemaHash: observed.hash,
    };
  });
  const producedAt = (options.clock ?? (() => new Date()))().toISOString();
  const payload = {
    schemaVersion: 1 as const,
    attestationKey: randomUUID(),
    probeSequence: binding.probeSequence,
    previousAttestationKey: binding.previousAttestationKey,
    tenantKey: manifest.tenantKey,
    projectKey: manifest.projectKey,
    serverKey: manifest.serverKey,
    serverRevision: manifest.revision,
    manifestHashAlgorithm: "sha256" as const,
    manifestHash: McpHealthAuthority.manifestHash(manifest),
    verifierKey: config.mcpVerifier.verifierKey,
    keyId: config.mcpVerifier.keyId,
    serverIdentityHashAlgorithm: "sha256" as const,
    serverIdentityHash: identityHash,
    protocolVersion: result.protocolVersion,
    observedTools,
    status: "healthy" as const,
    recoveryChallengeKey: binding.recoveryChallengeKey,
    producedAt,
  };
  const health = SignedMcpHealthAttestationSchema.parse({
    payload,
    signature: sign(
      null,
      Buffer.from(McpHealthAuthority.canonicalPayload(payload), "utf8"),
      privateKey,
    ).toString("base64"),
  });
  const bundle = parsePreparedMcpHealthRefresh({
    schemaVersion: 1,
    health,
  });
  assertHealthScope(bundle.health, config);
  assertHealthSignature(bundle.health, privateKey);
  await createPrivateFile(
    path.resolve(options.outputPath),
    `${JSON.stringify(bundle, null, 2)}\n`,
    check,
  );
  return bundle;
};

export const publishPreparedMcpHealthRefresh = async (options: {
  configPath: string;
  bundle: PreparedMcpHealthRefresh;
  fetcher?: FetchLike;
  assertPrivatePath?: PrivatePathCheck;
}): Promise<{ status: "refreshed" | "recovered"; serverKey: string }> => {
  const check = options.assertPrivatePath ?? defaultAssertPrivatePath;
  const config = await loadExtensionAdminConfig(options.configPath, check);
  const bundle = parsePreparedMcpHealthRefresh(options.bundle);
  assertHealthScope(bundle.health, config);
  const privateKey = createPrivateKey(
    await readPrivateText(config.mcpVerifierPrivateKeyPath, 32_768, check),
  );
  assertHealthSignature(bundle.health, privateKey);
  if (bundle.health.payload.probeSequence === Number.MAX_SAFE_INTEGER) {
    throw new Error("MCP 健康续期序号已经达到安全上限");
  }
  const token = sessionKey.parse(
    await readPrivateText(config.administratorSessionKeyPath, 1_024, check),
  );
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const payload = bundle.health.payload;
  const self = `/api/v1/extensions/mcp/${payload.serverKey}`;
  const recorded = await requestControlPlane({
    config,
    token,
    fetcher,
    method: "POST",
    pathname: `${self}/health`,
    body: { schemaVersion: 1, health: bundle.health },
    expectedStatus: 200,
  });
  const outcome = parseHealthOutcome(
    recorded.text,
    payload.probeSequence + 1,
    payload.attestationKey,
  );
  if (outcome.recoveryChallengeKey !== payload.recoveryChallengeKey) {
    throw new Error("控制面返回了与续期包不一致的 MCP 恢复挑战");
  }
  const shouldRecover = payload.recoveryChallengeKey !== null;
  if (shouldRecover) {
    await requestControlPlane({
      config,
      token,
      fetcher,
      method: "POST",
      pathname: `${self}/revisions/${payload.serverRevision}/recover`,
      body: {
        schemaVersion: 1,
        attestationKey: payload.attestationKey,
      },
      expectedStatus: 204,
    });
  }
  return {
    status: shouldRecover ? "recovered" : "refreshed",
    serverKey: payload.serverKey,
  };
};

export const publishPreparedMcpRelease = async (options: {
  configPath: string;
  bundle: PreparedMcpRelease;
  fetcher?: FetchLike;
  assertPrivatePath?: PrivatePathCheck;
}): Promise<{ status: "enabled"; serverKey: string; revision: number }> => {
  const check = options.assertPrivatePath ?? defaultAssertPrivatePath;
  const config = await loadExtensionAdminConfig(options.configPath, check);
  const bundle = parsePreparedMcpRelease(options.bundle);
  assertReleaseScope(bundle, config);
  const privateKey = createPrivateKey(
    await readPrivateText(config.mcpVerifierPrivateKeyPath, 32_768, check),
  );
  if (
    !verify(
      null,
      Buffer.from(
        McpHealthAuthority.canonicalPayload(bundle.health.payload),
        "utf8",
      ),
      createPublicKey(privateKey),
      Buffer.from(bundle.health.signature, "base64"),
    )
  ) {
    throw new Error("MCP 发布包健康证明签名无效");
  }
  const token = sessionKey.parse(
    await readPrivateText(config.administratorSessionKeyPath, 1_024, check),
  );
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const self = `/api/v1/extensions/mcp/${bundle.manifest.serverKey}`;
  const published = await requestControlPlane({
    config,
    token,
    fetcher,
    method: "POST",
    pathname: "/api/v1/extensions/mcp",
    body: {
      schemaVersion: 1,
      manifest: bundle.manifest,
      inputSchemas: bundle.inputSchemas,
    },
    expectedStatus: 201,
  });
  if (published.response.headers.get("location") !== self) {
    throw new Error("控制面返回了与 MCP 服务不一致的发布位置");
  }
  const recorded = await requestControlPlane({
    config,
    token,
    fetcher,
    method: "POST",
    pathname: `${self}/health`,
    body: { schemaVersion: 1, health: bundle.health },
    expectedStatus: 200,
  });
  if (
    parseHealthOutcome(recorded.text, 2, bundle.health.payload.attestationKey)
      .recoveryChallengeKey !== null
  ) {
    throw new Error("控制面返回了与当前 MCP 探测不一致的健康链");
  }
  await requestControlPlane({
    config,
    token,
    fetcher,
    method: "POST",
    pathname: `${self}/revisions/${bundle.manifest.revision}/enable`,
    body: { schemaVersion: 1 },
    expectedStatus: 204,
  });
  return {
    status: "enabled",
    serverKey: bundle.manifest.serverKey,
    revision: bundle.manifest.revision,
  };
};

export const loadMcpReleaseInput = async (
  inputPath: string,
  options: { assertPrivatePath?: PrivatePathCheck } = {},
): Promise<z.output<typeof McpReleaseInputSchema>> => {
  const check = options.assertPrivatePath ?? defaultAssertPrivatePath;
  return McpReleaseInputSchema.parse(
    parseJson(
      await readPrivateText(inputPath, 2 * 1024 * 1024, check),
      "MCP 发布输入",
    ),
  );
};

export const loadPreparedMcpRelease = async (
  bundlePath: string,
  options: { assertPrivatePath?: PrivatePathCheck } = {},
): Promise<PreparedMcpRelease> => {
  const check = options.assertPrivatePath ?? defaultAssertPrivatePath;
  return parsePreparedMcpRelease(
    parseJson(
      await readPrivateText(bundlePath, 8 * 1024 * 1024, check),
      "MCP 发布包",
    ),
  );
};

export const loadPreparedMcpHealthRefresh = async (
  bundlePath: string,
  options: { assertPrivatePath?: PrivatePathCheck } = {},
): Promise<PreparedMcpHealthRefresh> => {
  const check = options.assertPrivatePath ?? defaultAssertPrivatePath;
  return parsePreparedMcpHealthRefresh(
    parseJson(
      await readPrivateText(bundlePath, 4 * 1024 * 1024, check),
      "MCP 健康续期包",
    ),
  );
};
