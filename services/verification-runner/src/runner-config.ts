import { createPrivateKey, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  RunnerControlPlaneOriginSchema,
  RunnerSessionKeySchema,
} from "./control-plane-client.js";
import {
  VerificationRunnerScopeSchema,
  VerificationRunnerTargetSchema,
  type VerificationRunnerTarget,
} from "./model.js";
import {
  VerificationSuitePlanAnchorSchema,
  VerificationSuitePlanSchema,
  verificationSuitePlanHash,
  type VerificationSuitePlan,
  type VerificationSuitePlanProvider,
} from "./verification-engine.js";
import { assertTrustedPathAncestors } from "./trusted-executable.js";
import {
  assertDefaultWindowsPrivatePath,
  assertDefaultWindowsTrustedPath,
} from "./windows-path-security.js";

const absolutePath = z
  .string()
  .min(1)
  .max(1_000)
  .refine((value) => path.isAbsolute(value), "Runner 路径必须使用绝对路径");
const sha256Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const containerUser = z
  .string()
  .regex(/^[1-9]\d{0,9}:[1-9]\d{0,9}$/u, "容器用户必须使用非 root 的 uid:gid");

const RunnerFileConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    controlPlaneUrl: RunnerControlPlaneOriginSchema,
    sessionKeyPath: absolutePath,
    privateKeyPath: absolutePath,
    journalIntegrityKeyPath: absolutePath,
    journalPath: absolutePath,
    scope: VerificationRunnerScopeSchema,
    repositoryRoot: absolutePath,
    workspaceRoot: absolutePath,
    gitCommandPath: absolutePath,
    gitCommandSha256: sha256Hash,
    dockerCommandPath: absolutePath,
    dockerCommandSha256: sha256Hash,
    containerUser,
    plans: z.array(VerificationSuitePlanSchema).min(1).max(1_000),
    trustedPlanAnchors: z
      .array(VerificationSuitePlanAnchorSchema)
      .min(1)
      .max(1_000),
    idlePollIntervalMs: z.number().int().min(500).max(60_000).default(3_000),
    requestTimeoutMs: z.number().int().min(500).max(30_000).default(5_000),
  })
  .strict();

export interface VerificationRunnerConfig {
  controlPlaneUrl: string;
  sessionKey: string;
  privateKey: KeyObject;
  journalIntegrityKey: Uint8Array;
  journalPath: string;
  scope: z.infer<typeof VerificationRunnerScopeSchema>;
  repositoryRoot: string;
  workspaceRoot: string;
  gitCommandPath: string;
  gitCommandSha256: string;
  dockerCommandPath: string;
  dockerCommandSha256: string;
  containerUser: string;
  plans: VerificationSuitePlan[];
  trustedPlanAnchors: Array<z.infer<typeof VerificationSuitePlanAnchorSchema>>;
  idlePollIntervalMs: number;
  requestTimeoutMs: number;
}

type WindowsPrivatePathCheck = (target: string) => Promise<void>;

const samePath = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);

const assertPrivateParent = async (
  filePath: string,
  windowsCheck: WindowsPrivatePathCheck,
): Promise<void> => {
  const parent = path.dirname(filePath);
  const [metadata, resolvedRealPath] = await Promise.all([
    lstat(parent),
    realpath(parent),
  ]);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !samePath(resolvedRealPath, parent)
  ) {
    throw new Error("Runner 私有文件父目录必须是不跳转的本地目录");
  }
  if (process.platform === "win32") {
    await windowsCheck(parent);
  } else {
    const currentUser =
      typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      (Number(metadata.mode) & 0o077) !== 0 ||
      (currentUser !== undefined && metadata.uid !== currentUser)
    ) {
      throw new Error("Runner 私有文件父目录必须仅允许当前控制器身份访问");
    }
  }
};

const readPrivateFile = async (
  filePathInput: string,
  maxBytes: number,
  windowsCheck: WindowsPrivatePathCheck,
): Promise<string> => {
  const filePath = path.resolve(absolutePath.parse(filePathInput));
  await assertTrustedPathAncestors({
    targetPath: filePath,
    description: "Runner 私有文件",
    assertWindowsTrustedPath: assertDefaultWindowsTrustedPath,
  });
  await assertPrivateParent(filePath, windowsCheck);
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Runner 私有文件不能使用符号链接");
  }
  let handle;
  try {
    handle = await open(
      filePath,
      process.platform === "win32"
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.dev !== before.dev ||
      metadata.ino !== before.ino ||
      metadata.size < 1 ||
      metadata.size > maxBytes
    ) {
      throw new Error("Runner 私有文件大小或类型不正确");
    }
    if (process.platform === "win32") {
      await windowsCheck(filePath);
    } else {
      const currentUser =
        typeof process.getuid === "function" ? process.getuid() : undefined;
      if (
        (Number(metadata.mode) & 0o077) !== 0 ||
        (currentUser !== undefined && metadata.uid !== currentUser)
      ) {
        throw new Error("Runner 私有文件必须仅允许当前控制器身份读取");
      }
    }
    const content = await handle.readFile({ encoding: "utf8" });
    const [after, afterRealPath] = await Promise.all([
      lstat(filePath),
      realpath(filePath),
    ]);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.dev !== metadata.dev ||
      after.ino !== metadata.ino ||
      !samePath(afterRealPath, filePath)
    ) {
      throw new Error("Runner 私有文件在读取期间发生替换");
    }
    return content;
  } finally {
    await handle?.close();
  }
};

const planIdentity = (input: {
  repositoryKey: string;
  planKey: string;
  planVersion: number;
}): string => `${input.repositoryKey}:${input.planKey}:${input.planVersion}`;

const targetIdentity = (input: {
  repositoryKey: string;
  requirementKey: string;
  requirementRevision: number;
  gitHashAlgorithm: string;
  commitSha: string;
}): string =>
  `${input.repositoryKey}:${input.requirementKey}:${input.requirementRevision}:${input.gitHashAlgorithm}:${input.commitSha}`;

export class StaticVerificationSuitePlanProvider implements VerificationSuitePlanProvider {
  readonly #plans = new Map<string, VerificationSuitePlan>();

  constructor(plansInput: readonly VerificationSuitePlan[]) {
    const plans = z
      .array(VerificationSuitePlanSchema)
      .min(1)
      .max(1_000)
      .parse(plansInput);
    for (const plan of plans) {
      const identity = targetIdentity(plan);
      if (this.#plans.has(identity)) {
        throw new Error("同一权威提交不能配置多份验证计划");
      }
      this.#plans.set(identity, plan);
    }
  }

  async canHandle(targetInput: VerificationRunnerTarget): Promise<boolean> {
    const target = VerificationRunnerTargetSchema.parse(targetInput);
    return this.#plans.has(targetIdentity(target));
  }

  async planFor(
    targetInput: VerificationRunnerTarget,
  ): Promise<VerificationSuitePlan> {
    const target = VerificationRunnerTargetSchema.parse(targetInput);
    const plan = this.#plans.get(targetIdentity(target));
    if (!plan) throw new Error("当前权威提交没有配置可信验证计划");
    return VerificationSuitePlanSchema.parse(plan);
  }
}

export const loadVerificationRunnerConfig = async (
  configPathInput: string,
  options: { assertWindowsPrivatePath?: WindowsPrivatePathCheck } = {},
): Promise<VerificationRunnerConfig> => {
  const windowsCheck =
    options.assertWindowsPrivatePath ?? assertDefaultWindowsPrivatePath;
  const configPath = path.resolve(absolutePath.parse(configPathInput));
  const rawConfig = await readPrivateFile(
    configPath,
    1024 * 1024,
    windowsCheck,
  );
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawConfig) as unknown;
  } catch {
    throw new Error("Runner 配置文件不是有效 JSON");
  }
  const config = RunnerFileConfigSchema.parse(decoded);
  if (
    config.scope.repositoryKey !== config.plans[0]?.repositoryKey ||
    config.plans.some(
      (plan) => plan.repositoryKey !== config.scope.repositoryKey,
    )
  ) {
    throw new Error("Runner 验证计划不属于当前授权代码仓库");
  }
  const anchorHashes = new Map<string, string>();
  for (const anchor of config.trustedPlanAnchors) {
    const identity = planIdentity(anchor);
    if (anchorHashes.has(identity)) {
      throw new Error("Runner 不能重复配置同一验证计划锚");
    }
    anchorHashes.set(identity, anchor.planHash);
  }
  if (
    anchorHashes.size !== config.plans.length ||
    config.plans.some(
      (plan) =>
        anchorHashes.get(planIdentity(plan)) !==
        verificationSuitePlanHash(plan),
    )
  ) {
    throw new Error("Runner 验证计划没有与完整可信摘要逐项对应");
  }

  const [sessionKeyText, privateKeyText, integrityKeyText] = await Promise.all([
    readPrivateFile(config.sessionKeyPath, 1_024, windowsCheck),
    readPrivateFile(config.privateKeyPath, 32 * 1_024, windowsCheck),
    readPrivateFile(config.journalIntegrityKeyPath, 1_024, windowsCheck),
  ]);
  const sessionKey = RunnerSessionKeySchema.parse(sessionKeyText.trim());
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyText);
  } catch {
    throw new Error("Runner 签名私钥格式不正确");
  }
  if (
    privateKey.type !== "private" ||
    privateKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new Error("Runner 签名私钥必须是 Ed25519 私钥");
  }
  const encodedIntegrityKey = integrityKeyText.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encodedIntegrityKey)) {
    throw new Error("Runner 日志完整性密钥必须使用规范 Base64");
  }
  const integrityKey = Buffer.from(encodedIntegrityKey, "base64");
  if (
    integrityKey.byteLength < 32 ||
    integrityKey.byteLength > 128 ||
    integrityKey.toString("base64") !== encodedIntegrityKey
  ) {
    throw new Error("Runner 日志完整性密钥必须包含 32 至 128 字节");
  }

  return {
    controlPlaneUrl: config.controlPlaneUrl,
    sessionKey,
    privateKey,
    journalIntegrityKey: Uint8Array.from(integrityKey),
    journalPath: path.resolve(config.journalPath),
    scope: config.scope,
    repositoryRoot: path.resolve(config.repositoryRoot),
    workspaceRoot: path.resolve(config.workspaceRoot),
    gitCommandPath: path.resolve(config.gitCommandPath),
    gitCommandSha256: config.gitCommandSha256,
    dockerCommandPath: path.resolve(config.dockerCommandPath),
    dockerCommandSha256: config.dockerCommandSha256,
    containerUser: config.containerUser,
    plans: config.plans,
    trustedPlanAnchors: config.trustedPlanAnchors,
    idlePollIntervalMs: config.idlePollIntervalMs,
    requestTimeoutMs: config.requestTimeoutMs,
  };
};
