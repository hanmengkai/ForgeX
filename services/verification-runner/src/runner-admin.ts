import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  RunnerControlPlaneClient,
  RunnerControlPlaneOriginSchema,
} from "./control-plane-client.js";
import {
  VerificationRunnerScopeSchema,
  VerificationRunnerTargetSchema,
  type VerificationRunnerTarget,
} from "./model.js";
import {
  assertVerificationSuitePlanTarget,
  VerificationSuitePlanSchema,
  verificationSuitePlanHash,
} from "./verification-engine.js";
import {
  assertDefaultWindowsTrustedPath,
  assertTrustedPathAncestors,
  hashTrustedExecutable,
  type WindowsTrustedPathCheck,
} from "./trusted-executable.js";
import { assertDefaultWindowsPrivatePath } from "./windows-path-security.js";

const absolutePath = z
  .string()
  .min(1)
  .max(1_000)
  .refine((value) => path.isAbsolute(value), "Runner 路径必须使用绝对路径");
const internalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const containerUser = z.string().regex(/^[1-9]\d{0,9}:[1-9]\d{0,9}$/u);

export const VerificationRunnerBootstrapInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    runnerName: z.string().trim().min(2).max(100),
    controlPlaneUrl: RunnerControlPlaneOriginSchema,
    scope: z
      .object({
        tenantKey: internalKey,
        projectKey: internalKey,
        repositoryKey: internalKey,
      })
      .strict(),
    repositoryRoot: absolutePath,
    workspaceRoot: absolutePath,
    gitCommandPath: absolutePath,
    dockerCommandPath: absolutePath,
    containerUser,
    idlePollIntervalMs: z.number().int().min(500).max(60_000).default(3_000),
    requestTimeoutMs: z.number().int().min(500).max(30_000).default(5_000),
  })
  .strict();

export type VerificationRunnerBootstrapInput = z.input<
  typeof VerificationRunnerBootstrapInputSchema
>;

const BootstrapConfigSchema = z
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
    gitCommandSha256: sha256,
    dockerCommandPath: absolutePath,
    dockerCommandSha256: sha256,
    containerUser,
    plans: z.array(VerificationSuitePlanSchema).max(1_000),
    trustedPlanAnchors: z.array(z.unknown()).max(1_000),
    idlePollIntervalMs: z.number().int().min(500).max(60_000),
    requestTimeoutMs: z.number().int().min(500).max(30_000),
  })
  .strict()
  .refine(
    (config) =>
      config.plans.length === 0 && config.trustedPlanAnchors.length === 0,
    "Runner bootstrap 配置不能预先夹带验证计划",
  );

type PrivatePathCheck = (targetPath: string) => Promise<void>;

const samePath = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);

const defaultAssertPrivatePath: PrivatePathCheck = async (targetPath) => {
  if (process.platform === "win32") {
    await assertDefaultWindowsPrivatePath(targetPath);
    return;
  }
  const metadata = await lstat(targetPath);
  const currentUser = process.getuid?.();
  if (
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (currentUser !== undefined && metadata.uid !== currentUser)
  ) {
    throw new Error("Runner 管理文件必须仅允许当前控制器身份访问");
  }
};

const assertPrivateDirectory = async (
  directoryInput: string,
  check: PrivatePathCheck,
): Promise<string> => {
  const directory = path.resolve(absolutePath.parse(directoryInput));
  const [metadata, resolvedRealPath] = await Promise.all([
    lstat(directory),
    realpath(directory),
  ]);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !samePath(resolvedRealPath, directory)
  ) {
    throw new Error("Runner 管理目录必须是不跳转的普通目录");
  }
  await assertTrustedPathAncestors({
    targetPath: directory,
    description: "Runner 管理目录",
  });
  await check(directory);
  return directory;
};

const createPrivateFile = async (
  filePath: string,
  contents: string,
  check: PrivatePathCheck,
): Promise<void> => {
  let handle;
  let created = false;
  try {
    handle = await open(filePath, "wx", 0o600);
    created = true;
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== "win32") await chmod(filePath, 0o600);
    await check(filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await unlink(filePath).catch(() => undefined);
    throw error;
  }
};

const readPrivateText = async (
  filePathInput: string,
  maxBytes: number,
  check: PrivatePathCheck,
): Promise<string> => {
  const filePath = path.resolve(absolutePath.parse(filePathInput));
  await assertPrivateDirectory(path.dirname(filePath), check);
  const before = await lstat(filePath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1 ||
    before.size > maxBytes
  ) {
    throw new Error("Runner 管理文件大小或类型不正确");
  }
  await check(filePath);
  const handle = await open(
    filePath,
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (metadata.dev !== before.dev || metadata.ino !== before.ino) {
      throw new Error("Runner 管理文件在读取期间发生替换");
    }
    const contents = await handle.readFile({ encoding: "utf8" });
    const after = await lstat(filePath);
    if (
      after.dev !== metadata.dev ||
      after.ino !== metadata.ino ||
      after.isSymbolicLink()
    ) {
      throw new Error("Runner 管理文件在读取期间发生替换");
    }
    return contents;
  } finally {
    await handle.close();
  }
};

const parseJson = (contents: string, label: string): unknown => {
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`${label}不是有效 JSON`);
  }
};

export const loadVerificationRunnerBootstrapInput = async (
  inputPath: string,
  options: { assertPrivatePath?: PrivatePathCheck } = {},
): Promise<z.output<typeof VerificationRunnerBootstrapInputSchema>> => {
  const check = options.assertPrivatePath ?? defaultAssertPrivatePath;
  return VerificationRunnerBootstrapInputSchema.parse(
    parseJson(
      await readPrivateText(inputPath, 1024 * 1024, check),
      "Runner bootstrap 输入",
    ),
  );
};

export const bootstrapVerificationRunner = async (
  input: VerificationRunnerBootstrapInput,
  options: {
    outputDirectory: string;
    assertPrivatePath?: PrivatePathCheck;
    assertWindowsTrustedPath?: WindowsTrustedPathCheck;
  },
): Promise<{
  bootstrapConfigPath: string;
  controlPlaneFragmentPath: string;
}> => {
  const parsed = VerificationRunnerBootstrapInputSchema.parse(input);
  const check = options.assertPrivatePath ?? defaultAssertPrivatePath;
  const outputDirectory = await assertPrivateDirectory(
    options.outputDirectory,
    check,
  );
  const [gitCommandSha256, dockerCommandSha256] = await Promise.all([
    hashTrustedExecutable({
      commandPath: parsed.gitCommandPath,
      description: "Runner Git 程序",
      assertWindowsTrustedPath:
        options.assertWindowsTrustedPath ?? assertDefaultWindowsTrustedPath,
    }),
    hashTrustedExecutable({
      commandPath: parsed.dockerCommandPath,
      description: "Runner Docker 程序",
      assertWindowsTrustedPath:
        options.assertWindowsTrustedPath ?? assertDefaultWindowsTrustedPath,
    }),
  ]);
  const runnerKey = randomUUID();
  const keyId = randomUUID();
  const sessionKey = randomBytes(32).toString("base64url");
  const journalIntegrityKey = randomBytes(32).toString("base64");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const paths = {
    sessionKeyPath: path.join(outputDirectory, "session.key"),
    privateKeyPath: path.join(outputDirectory, "evidence-ed25519.pem"),
    journalIntegrityKeyPath: path.join(
      outputDirectory,
      "journal-integrity.key",
    ),
    journalPath: path.join(outputDirectory, "verification-journal.json"),
    bootstrapConfigPath: path.join(outputDirectory, "runner.bootstrap.json"),
    controlPlaneFragmentPath: path.join(
      outputDirectory,
      "control-plane.runner.json",
    ),
  };
  const bootstrapConfig = {
    schemaVersion: 1,
    controlPlaneUrl: parsed.controlPlaneUrl,
    sessionKeyPath: paths.sessionKeyPath,
    privateKeyPath: paths.privateKeyPath,
    journalIntegrityKeyPath: paths.journalIntegrityKeyPath,
    journalPath: paths.journalPath,
    scope: {
      ...parsed.scope,
      runnerKey,
      keyId,
    },
    repositoryRoot: path.resolve(parsed.repositoryRoot),
    workspaceRoot: path.resolve(parsed.workspaceRoot),
    gitCommandPath: path.resolve(parsed.gitCommandPath),
    gitCommandSha256,
    dockerCommandPath: path.resolve(parsed.dockerCommandPath),
    dockerCommandSha256,
    containerUser: parsed.containerUser,
    plans: [],
    trustedPlanAnchors: [],
    idlePollIntervalMs: parsed.idlePollIntervalMs,
    requestTimeoutMs: parsed.requestTimeoutMs,
  };
  const controlPlaneFragment = {
    runnerSessions: [
      {
        tokenSha256: createHash("sha256")
          .update(sessionKey, "utf8")
          .digest("hex"),
        runner: { tenantKey: parsed.scope.tenantKey, runnerKey, keyId },
      },
    ],
    trustedRunners: [
      {
        runnerKey,
        keyId,
        runnerName: parsed.runnerName,
        publicKeyBase64: publicKey
          .export({ type: "spki", format: "der" })
          .toString("base64"),
        scopes: [parsed.scope],
        acceptNewEvidence: true,
      },
    ],
  };
  const created: string[] = [];
  try {
    for (const [filePath, contents] of [
      [paths.sessionKeyPath, `${sessionKey}\n`],
      [
        paths.privateKeyPath,
        privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      ],
      [paths.journalIntegrityKeyPath, `${journalIntegrityKey}\n`],
      [
        paths.bootstrapConfigPath,
        `${JSON.stringify(bootstrapConfig, null, 2)}\n`,
      ],
      [
        paths.controlPlaneFragmentPath,
        `${JSON.stringify(controlPlaneFragment, null, 2)}\n`,
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
  return {
    bootstrapConfigPath: paths.bootstrapConfigPath,
    controlPlaneFragmentPath: paths.controlPlaneFragmentPath,
  };
};

const loadBootstrapConfig = async (
  configPath: string,
  check: PrivatePathCheck,
) =>
  BootstrapConfigSchema.parse(
    parseJson(
      await readPrivateText(configPath, 1024 * 1024, check),
      "Runner bootstrap 配置",
    ),
  );

export const listVerificationRunnerTargets = async (
  bootstrapConfigPath: string,
  options: {
    listPending?: () => Promise<VerificationRunnerTarget[]>;
    assertPrivatePath?: PrivatePathCheck;
  } = {},
): Promise<VerificationRunnerTarget[]> => {
  const check = options.assertPrivatePath ?? defaultAssertPrivatePath;
  const config = await loadBootstrapConfig(bootstrapConfigPath, check);
  return listTargetsForConfig(config, check, options.listPending);
};

const listTargetsForConfig = async (
  config: z.infer<typeof BootstrapConfigSchema>,
  check: PrivatePathCheck,
  supplied?: () => Promise<VerificationRunnerTarget[]>,
): Promise<VerificationRunnerTarget[]> => {
  let listPending = supplied;
  if (!listPending) {
    const client = new RunnerControlPlaneClient({
      baseUrl: config.controlPlaneUrl,
      sessionKey: (
        await readPrivateText(config.sessionKeyPath, 1_024, check)
      ).trim(),
      requestTimeoutMs: config.requestTimeoutMs,
    });
    listPending = () => client.listPending(100);
  }
  return z
    .array(VerificationRunnerTargetSchema)
    .max(100)
    .parse(await listPending());
};

export const finalizeVerificationRunnerPlan = async (
  input: {
    bootstrapConfigPath: string;
    planPath: string;
    outputPath: string;
  },
  options: {
    listPending?: () => Promise<VerificationRunnerTarget[]>;
    assertPrivatePath?: PrivatePathCheck;
  } = {},
): Promise<void> => {
  const check = options.assertPrivatePath ?? defaultAssertPrivatePath;
  const config = await loadBootstrapConfig(input.bootstrapConfigPath, check);
  const plan = VerificationSuitePlanSchema.parse(
    parseJson(
      await readPrivateText(input.planPath, 1024 * 1024, check),
      "Runner 验证计划",
    ),
  );
  const targets = await listTargetsForConfig(
    config,
    check,
    options.listPending,
  );
  const target = targets.find(
    (candidate) =>
      candidate.repositoryKey === plan.repositoryKey &&
      candidate.requirementKey === plan.requirementKey &&
      candidate.requirementRevision === plan.requirementRevision &&
      candidate.gitHashAlgorithm === plan.gitHashAlgorithm &&
      candidate.commitSha === plan.commitSha,
  );
  if (!target) {
    throw new Error("验证计划对应的任务已不再等待独立验证");
  }
  assertVerificationSuitePlanTarget(target, plan);
  await assertPrivateDirectory(path.dirname(input.outputPath), check);
  await createPrivateFile(
    path.resolve(input.outputPath),
    `${JSON.stringify(
      {
        ...config,
        plans: [plan],
        trustedPlanAnchors: [
          {
            repositoryKey: plan.repositoryKey,
            planKey: plan.planKey,
            planVersion: plan.planVersion,
            planHash: verificationSuitePlanHash(plan),
          },
        ],
      },
      null,
      2,
    )}\n`,
    check,
  );
};
