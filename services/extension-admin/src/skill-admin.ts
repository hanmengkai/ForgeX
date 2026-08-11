import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import {
  SignedSkillEvaluationSchema,
  SkillEvaluationAuthority,
  SkillPackageCodec,
  SkillPackageManifestSchema,
  type SkillPackageContent,
} from "@forgex/extensions";
import { containsLikelyPlaintextCredential } from "@forgex/application";
import { z } from "zod";

import {
  assertPrivateDirectory,
  createPrivateFile,
  defaultAssertPrivatePath,
  parseJson,
  readPrivateText,
  type PrivatePathCheck,
} from "./private-files.js";

const internalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const absolutePath = z
  .string()
  .min(1)
  .max(1_000)
  .refine((value) => path.isAbsolute(value), "路径必须使用绝对路径");
const semanticVersion = z
  .string()
  .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);

const controlPlaneOrigin = z
  .url()
  .transform((value) => new URL(value))
  .refine(
    (url) =>
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "::1"].includes(url.hostname))),
    "控制面必须使用 HTTPS；本机开发可使用回环 HTTP",
  )
  .transform((url) => url.origin);

export const ExtensionAdminBootstrapInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    administratorName: z.string().trim().min(2).max(80),
    controlPlaneUrl: controlPlaneOrigin,
    administratorSessionKeyPath: absolutePath,
    scope: z
      .object({ tenantKey: internalKey, projectKey: internalKey })
      .strict(),
    requestTimeoutMs: z.number().int().min(500).max(30_000).default(5_000),
  })
  .strict();

const extensionAuthoritySchema = z
  .object({
    evaluatorKey: internalKey,
    keyId: internalKey,
    evaluatorName: z.string().trim().min(2).max(100),
  })
  .strict();

const ExtensionAdminConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    controlPlaneUrl: controlPlaneOrigin,
    administratorSessionKeyPath: absolutePath,
    evaluatorPrivateKeyPath: absolutePath,
    mcpVerifierPrivateKeyPath: absolutePath,
    scope: z
      .object({ tenantKey: internalKey, projectKey: internalKey })
      .strict(),
    evaluator: extensionAuthoritySchema,
    mcpVerifier: z
      .object({
        verifierKey: internalKey,
        keyId: internalKey,
        verifierName: z.string().trim().min(2).max(100),
      })
      .strict(),
    requestTimeoutMs: z.number().int().min(500).max(30_000),
  })
  .strict();

export const SkillReleaseInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    skillKey: internalKey.optional(),
    version: semanticVersion,
    name: z.string().trim().min(2).max(100),
    summary: z.string().trim().min(4).max(500),
    sourceDirectory: absolutePath,
    compatibleBlueprints: z.array(z.string().trim().min(2).max(100)).max(20),
    requiredCapabilities: z.array(z.string().trim().min(2).max(100)).max(50),
    permissions: z
      .object({
        workspace: z.enum(["read_only", "write_scoped"]),
        network: z.enum(["none", "approved_destinations"]),
        commands: z.enum(["none", "sandboxed"]),
      })
      .strict(),
  })
  .strict();

export const PreparedSkillReleaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    manifest: SkillPackageManifestSchema,
    artifactContentBase64: z.string().min(1),
    evaluation: SignedSkillEvaluationSchema,
  })
  .strict();

export type PreparedSkillRelease = z.infer<typeof PreparedSkillReleaseSchema>;

const sessionKey = z
  .string()
  .trim()
  .min(16)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const bootstrapExtensionAdmin = async (
  input: z.input<typeof ExtensionAdminBootstrapInputSchema>,
  options: {
    outputDirectory: string;
    assertPrivatePath?: PrivatePathCheck;
  },
): Promise<{
  configPath: string;
  controlPlaneFragmentPath: string;
  evaluatorPrivateKeyPath: string;
  mcpVerifierPrivateKeyPath: string;
}> => {
  const parsed = ExtensionAdminBootstrapInputSchema.parse(input);
  const check = options.assertPrivatePath ?? defaultAssertPrivatePath;
  const outputDirectory = await assertPrivateDirectory(
    options.outputDirectory,
    check,
  );
  sessionKey.parse(
    await readPrivateText(parsed.administratorSessionKeyPath, 1_024, check),
  );
  const evaluatorKey = randomUUID();
  const evaluatorKeyId = randomUUID();
  const verifierKey = randomUUID();
  const verifierKeyId = randomUUID();
  const evaluatorKeys = generateKeyPairSync("ed25519");
  const verifierKeys = generateKeyPairSync("ed25519");
  const paths = {
    configPath: path.join(outputDirectory, "extension-admin.config.json"),
    controlPlaneFragmentPath: path.join(
      outputDirectory,
      "control-plane.extensions.json",
    ),
    evaluatorPrivateKeyPath: path.join(
      outputDirectory,
      "skill-evaluation-ed25519.pem",
    ),
    mcpVerifierPrivateKeyPath: path.join(
      outputDirectory,
      "mcp-health-ed25519.pem",
    ),
  };
  const config = ExtensionAdminConfigSchema.parse({
    schemaVersion: 1,
    controlPlaneUrl: parsed.controlPlaneUrl,
    administratorSessionKeyPath: path.resolve(
      parsed.administratorSessionKeyPath,
    ),
    evaluatorPrivateKeyPath: paths.evaluatorPrivateKeyPath,
    mcpVerifierPrivateKeyPath: paths.mcpVerifierPrivateKeyPath,
    scope: parsed.scope,
    evaluator: {
      evaluatorKey,
      keyId: evaluatorKeyId,
      evaluatorName: `${parsed.administratorName} Skill 基线评测器`,
    },
    mcpVerifier: {
      verifierKey,
      keyId: verifierKeyId,
      verifierName: `${parsed.administratorName} MCP 本地探测器`,
    },
    requestTimeoutMs: parsed.requestTimeoutMs,
  });
  const publicKeyBase64 = (key: typeof evaluatorKeys.publicKey): string =>
    key.export({ type: "spki", format: "der" }).toString("base64");
  const fragment = {
    skillEvaluators: [
      {
        ...config.evaluator,
        publicKeyBase64: publicKeyBase64(evaluatorKeys.publicKey),
        scopes: [config.scope],
        acceptNewEvaluations: true,
      },
    ],
    mcpVerifiers: [
      {
        ...config.mcpVerifier,
        publicKeyBase64: publicKeyBase64(verifierKeys.publicKey),
        scopes: [config.scope],
        acceptNewAttestations: true,
      },
    ],
  };
  const created: string[] = [];
  try {
    for (const [filePath, contents] of [
      [
        paths.evaluatorPrivateKeyPath,
        evaluatorKeys.privateKey
          .export({ type: "pkcs8", format: "pem" })
          .toString(),
      ],
      [
        paths.mcpVerifierPrivateKeyPath,
        verifierKeys.privateKey
          .export({ type: "pkcs8", format: "pem" })
          .toString(),
      ],
      [paths.configPath, `${JSON.stringify(config, null, 2)}\n`],
      [
        paths.controlPlaneFragmentPath,
        `${JSON.stringify(fragment, null, 2)}\n`,
      ],
    ] as const) {
      await createPrivateFile(filePath, contents, check);
      created.push(filePath);
    }
  } catch (error) {
    await Promise.all(
      created.map((filePath) => unlink(filePath).catch(() => undefined)),
    );
    throw error;
  }
  return paths;
};

const loadConfig = async (
  configPath: string,
  check: PrivatePathCheck,
): Promise<z.infer<typeof ExtensionAdminConfigSchema>> =>
  ExtensionAdminConfigSchema.parse(
    parseJson(
      await readPrivateText(configPath, 1024 * 1024, check),
      "扩展管理配置",
    ),
  );

const samePath = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);

const sameFileMetadata = (
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const readSourceFile = async (
  root: string,
  relativePath: string,
  maxBytes: number,
  check: PrivatePathCheck,
): Promise<string> => {
  const target = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Skill 资源不能离开源码目录");
  }
  const [before, resolved] = await Promise.all([
    lstat(target),
    realpath(target),
  ]);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1 ||
    before.size > maxBytes ||
    !samePath(resolved, target)
  ) {
    throw new Error("Skill 资源必须是不跳转的普通 UTF-8 文件");
  }
  await check(path.dirname(target));
  await check(target);
  const handle = await open(
    target,
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (!sameFileMetadata(opened, before)) {
      throw new Error("Skill 资源在读取期间发生替换");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const buffer = Buffer.allocUnsafe(
        Math.min(64 * 1024, maxBytes + 1 - total),
      );
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error("Skill 资源超过大小上限");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const [afterHandle, afterPath] = await Promise.all([
      handle.stat(),
      lstat(target),
    ]);
    if (
      !sameFileMetadata(afterHandle, opened) ||
      !sameFileMetadata(afterPath, opened) ||
      afterPath.isSymbolicLink()
    ) {
      throw new Error("Skill 资源在读取期间发生替换");
    }
    await check(target);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, total),
    );
  } finally {
    await handle.close();
  }
};

const resourceMediaType = (
  resourcePath: string,
): "text/markdown" | "text/plain" | "application/json" => {
  const extension = path.posix.extname(resourcePath).toLowerCase();
  if (extension === ".md") return "text/markdown";
  if (extension === ".txt") return "text/plain";
  if (extension === ".json") return "application/json";
  throw new Error("Skill 交付资源只支持 Markdown、纯文本和 JSON");
};

const listResourcePaths = async (
  root: string,
  relativeDirectory: "references" | "assets",
  check: PrivatePathCheck,
): Promise<string[]> => {
  const directory = path.join(root, relativeDirectory);
  let entries;
  try {
    const [metadata, resolved] = await Promise.all([
      lstat(directory),
      realpath(directory),
    ]);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !samePath(directory, resolved)
    ) {
      throw new Error("Skill 资源目录必须是不跳转的普通目录");
    }
    await check(directory);
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
  const result: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  )) {
    if (entry.isSymbolicLink()) {
      throw new Error("Skill 资源目录不能包含符号链接");
    }
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      result.push(
        ...(await listNestedResourcePaths(root, relativePath, check)),
      );
    } else if (entry.isFile()) {
      resourceMediaType(relativePath);
      result.push(relativePath);
    } else {
      throw new Error("Skill 资源目录只能包含普通文件和目录");
    }
  }
  return result;
};

const listNestedResourcePaths = async (
  root: string,
  relativeDirectory: string,
  check: PrivatePathCheck,
): Promise<string[]> => {
  const directory = path.join(root, ...relativeDirectory.split("/"));
  const [metadata, resolved] = await Promise.all([
    lstat(directory),
    realpath(directory),
  ]);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !samePath(directory, resolved)
  ) {
    throw new Error("Skill 资源目录必须是不跳转的普通目录");
  }
  await check(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  )) {
    if (entry.isSymbolicLink()) {
      throw new Error("Skill 资源目录不能包含符号链接");
    }
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      result.push(
        ...(await listNestedResourcePaths(root, relativePath, check)),
      );
    } else if (entry.isFile()) {
      resourceMediaType(relativePath);
      result.push(relativePath);
    } else {
      throw new Error("Skill 资源目录只能包含普通文件和目录");
    }
  }
  return result;
};

const buildSkillPackage = async (
  sourceDirectoryInput: string,
  check: PrivatePathCheck,
): Promise<SkillPackageContent> => {
  const sourceDirectory = await assertPrivateDirectory(
    sourceDirectoryInput,
    check,
  );
  const resourcePaths = [
    ...(await listResourcePaths(sourceDirectory, "references", check)),
    ...(await listResourcePaths(sourceDirectory, "assets", check)),
  ].sort();
  return {
    schemaVersion: 1,
    instructions: await readSourceFile(
      sourceDirectory,
      "SKILL.md",
      200_000,
      check,
    ),
    resources: await Promise.all(
      resourcePaths.map(async (resourcePath) => {
        const content = await readSourceFile(
          sourceDirectory,
          resourcePath,
          2_800_000,
          check,
        );
        if (resourcePath.endsWith(".json")) {
          try {
            JSON.parse(content);
          } catch {
            throw new Error(`Skill JSON 资源格式不正确：${resourcePath}`);
          }
        }
        return {
          path: resourcePath,
          mediaType: resourceMediaType(resourcePath),
          encoding: "utf8" as const,
          content,
        };
      }),
    ),
  };
};

export const prepareSkillRelease = async (
  input: z.input<typeof SkillReleaseInputSchema>,
  options: {
    configPath: string;
    outputPath: string;
    assertPrivatePath?: PrivatePathCheck;
    clock?: () => Date;
  },
): Promise<PreparedSkillRelease> => {
  const parsed = SkillReleaseInputSchema.parse(input);
  const check = options.assertPrivatePath ?? defaultAssertPrivatePath;
  const config = await loadConfig(options.configPath, check);
  const content = await buildSkillPackage(parsed.sourceDirectory, check);
  const visibleText = [
    parsed.name,
    parsed.summary,
    ...parsed.compatibleBlueprints,
    ...parsed.requiredCapabilities,
    content.instructions,
    ...content.resources.map((resource) => resource.content),
  ];
  if (visibleText.some(containsLikelyPlaintextCredential)) {
    throw new Error(
      "Skill 中检测到疑似明文凭据；请先脱敏，凭据只能保留在客户设备本地",
    );
  }
  const artifact = SkillPackageCodec.encode(content);
  const producedAt = (options.clock ?? (() => new Date()))().toISOString();
  const manifest = SkillPackageManifestSchema.parse({
    schemaVersion: 1,
    skillKey: parsed.skillKey ?? randomUUID(),
    tenantKey: config.scope.tenantKey,
    projectKey: config.scope.projectKey,
    version: parsed.version,
    name: parsed.name,
    summary: parsed.summary,
    artifactHashAlgorithm: "sha256",
    artifactHash: createHash("sha256").update(artifact).digest("hex"),
    artifactSizeBytes: artifact.byteLength,
    entrypoint: "SKILL.md",
    compatibleBlueprints: parsed.compatibleBlueprints,
    requiredCapabilities: parsed.requiredCapabilities,
    permissions: parsed.permissions,
    createdAt: producedAt,
  });
  const deliverySafePermissions =
    manifest.permissions.workspace === "read_only" &&
    manifest.permissions.network === "none" &&
    manifest.permissions.commands === "none";
  const scenarios = [
    SkillPackageCodec.encode(SkillPackageCodec.decode(artifact)).byteLength ===
      artifact.byteLength,
    manifest.artifactHash ===
      createHash("sha256").update(artifact).digest("hex"),
    manifest.tenantKey === config.scope.tenantKey &&
      manifest.projectKey === config.scope.projectKey,
    deliverySafePermissions,
    content.resources.every(
      (resource) =>
        !resource.path.startsWith("scripts/") &&
        ["text/markdown", "text/plain", "application/json"].includes(
          resource.mediaType,
        ),
    ),
  ];
  const passedScenarioCount = scenarios.filter(Boolean).length;
  const evaluationPayload = {
    schemaVersion: 1 as const,
    evaluationKey: randomUUID(),
    tenantKey: config.scope.tenantKey,
    projectKey: config.scope.projectKey,
    skillKey: manifest.skillKey,
    skillVersion: manifest.version,
    artifactHashAlgorithm: "sha256" as const,
    artifactHash: manifest.artifactHash,
    manifestHashAlgorithm: "sha256" as const,
    manifestHash: SkillEvaluationAuthority.manifestHash(manifest),
    evaluatorKey: config.evaluator.evaluatorKey,
    keyId: config.evaluator.keyId,
    suiteName: "ForgeX Skill 安全发布基线",
    suiteRevision: 1,
    producedAt,
    outcome: passedScenarioCount === scenarios.length ? "passed" : "failed",
    score: passedScenarioCount * 20,
    scenarioCount: scenarios.length,
    passedScenarioCount,
    criticalFailureCount: deliverySafePermissions ? 0 : 1,
  } as const;
  const privateKey = createPrivateKey(
    await readPrivateText(config.evaluatorPrivateKeyPath, 16 * 1024, check),
  );
  const evaluation = SignedSkillEvaluationSchema.parse({
    payload: evaluationPayload,
    signature: sign(
      null,
      Buffer.from(
        SkillEvaluationAuthority.canonicalPayload(evaluationPayload),
        "utf8",
      ),
      privateKey,
    ).toString("base64"),
  });
  const bundle = PreparedSkillReleaseSchema.parse({
    schemaVersion: 1,
    manifest,
    artifactContentBase64: Buffer.from(artifact).toString("base64"),
    evaluation,
  });
  await assertPrivateDirectory(path.dirname(options.outputPath), check);
  await createPrivateFile(
    path.resolve(options.outputPath),
    `${JSON.stringify(bundle, null, 2)}\n`,
    check,
  );
  return bundle;
};

type FetchLike = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

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

export const publishPreparedSkillRelease = async (options: {
  configPath: string;
  bundle: PreparedSkillRelease;
  fetcher?: FetchLike;
  assertPrivatePath?: PrivatePathCheck;
}): Promise<{
  status: "activated" | "evaluation_failed";
  skillKey: string;
}> => {
  const check = options.assertPrivatePath ?? defaultAssertPrivatePath;
  const config = await loadConfig(options.configPath, check);
  const bundle = PreparedSkillReleaseSchema.parse(options.bundle);
  if (
    bundle.manifest.tenantKey !== config.scope.tenantKey ||
    bundle.manifest.projectKey !== config.scope.projectKey ||
    bundle.evaluation.payload.skillKey !== bundle.manifest.skillKey ||
    bundle.evaluation.payload.skillVersion !== bundle.manifest.version ||
    bundle.evaluation.payload.artifactHash !== bundle.manifest.artifactHash ||
    bundle.evaluation.payload.manifestHash !==
      SkillEvaluationAuthority.manifestHash(bundle.manifest)
  ) {
    throw new Error("Skill 发布包与扩展管理范围或评测绑定不一致");
  }
  const token = sessionKey.parse(
    await readPrivateText(config.administratorSessionKeyPath, 1_024, check),
  );
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const request = async (
    pathname: string,
    body: unknown,
    expectedStatus: number,
  ): Promise<Response> => {
    let response: Response;
    try {
      response = await fetcher(`${config.controlPlaneUrl}${pathname}`, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      await readBoundedResponse(response);
    } catch {
      throw new Error("扩展管理请求未完成，请使用同一个发布包安全重试");
    }
    if (response.status !== expectedStatus) {
      throw new Error("控制面拒绝了扩展管理请求，请检查权限和发布内容");
    }
    return response;
  };
  const self = `/api/v1/extensions/skills/${bundle.manifest.skillKey}`;
  const publishResponse = await request(
    "/api/v1/extensions/skills",
    {
      schemaVersion: 1,
      manifest: bundle.manifest,
      artifactContentBase64: bundle.artifactContentBase64,
    },
    201,
  );
  if (publishResponse.headers.get("location") !== self) {
    throw new Error("控制面返回了与 Skill 不一致的发布位置");
  }
  await request(
    `${self}/evaluations`,
    { schemaVersion: 1, evaluation: bundle.evaluation },
    204,
  );
  if (bundle.evaluation.payload.outcome !== "passed") {
    return { status: "evaluation_failed", skillKey: bundle.manifest.skillKey };
  }
  await request(
    `${self}/versions/${encodeURIComponent(bundle.manifest.version)}/activate`,
    { schemaVersion: 1 },
    204,
  );
  return { status: "activated", skillKey: bundle.manifest.skillKey };
};

export const loadSkillReleaseInput = async (
  inputPath: string,
  options: { assertPrivatePath?: PrivatePathCheck } = {},
): Promise<z.output<typeof SkillReleaseInputSchema>> => {
  const check = options.assertPrivatePath ?? defaultAssertPrivatePath;
  return SkillReleaseInputSchema.parse(
    parseJson(
      await readPrivateText(inputPath, 1024 * 1024, check),
      "Skill 发布输入",
    ),
  );
};

export const loadPreparedSkillRelease = async (
  bundlePath: string,
  options: { assertPrivatePath?: PrivatePathCheck } = {},
): Promise<PreparedSkillRelease> => {
  const check = options.assertPrivatePath ?? defaultAssertPrivatePath;
  return PreparedSkillReleaseSchema.parse(
    parseJson(
      await readPrivateText(bundlePath, 30 * 1024 * 1024, check),
      "Skill 发布包",
    ),
  );
};

export const loadExtensionAdminBootstrapInput = async (
  inputPath: string,
  options: { assertPrivatePath?: PrivatePathCheck } = {},
): Promise<z.output<typeof ExtensionAdminBootstrapInputSchema>> => {
  const check = options.assertPrivatePath ?? defaultAssertPrivatePath;
  return ExtensionAdminBootstrapInputSchema.parse(
    parseJson(
      await readPrivateText(inputPath, 1024 * 1024, check),
      "扩展管理 bootstrap 输入",
    ),
  );
};
