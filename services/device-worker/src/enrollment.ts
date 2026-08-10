import { randomBytes } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { WorkerConnectionCredentialSchema } from "@forgex/contracts";
import { z } from "zod";

import { assertPrivateWindowsPath } from "./windows-path-security.js";
import { DeviceWorkerConfigSchema } from "./config.js";
import { readBoundedControlPlaneResponse } from "./control-plane-client.js";

const fingerprintPattern = /^[a-f0-9]{64}$/u;

type PrivatePathCheck = (targetPath: string) => Promise<void>;

const defaultAssertPrivatePath = async (targetPath: string): Promise<void> => {
  if (process.platform === "win32") {
    await assertPrivateWindowsPath(targetPath);
    return;
  }
  const info = await lstat(targetPath);
  if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error(`设备私有路径权限不安全：${targetPath}`);
  }
};

const writePrivateFile = async (
  targetPath: string,
  content: string,
  assertPrivatePath: PrivatePathCheck = defaultAssertPrivatePath,
): Promise<void> => {
  const parent = path.dirname(targetPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertPrivatePath(parent);
  const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
    if (process.platform !== "win32") await chmod(targetPath, 0o600);
    await assertPrivatePath(targetPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

export const loadOrCreateAccountFingerprint = async (
  identityPath: string,
  assertPrivatePath: PrivatePathCheck = defaultAssertPrivatePath,
): Promise<string> => {
  const resolved = path.resolve(identityPath);
  try {
    const info = await lstat(resolved);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("设备账户身份必须是普通文件");
    }
    await assertPrivatePath(resolved);
    const value = (await readFile(resolved, "utf8")).trim().toLowerCase();
    if (!fingerprintPattern.test(value)) {
      throw new Error("设备账户身份文件格式不正确");
    }
    return value;
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const parent = path.dirname(resolved);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertPrivatePath(parent);
  const fingerprint = randomBytes(32).toString("hex");
  const readyPath = `${resolved}.${process.pid}.${randomBytes(8).toString("hex")}.ready`;
  await writePrivateFile(readyPath, `${fingerprint}\n`, assertPrivatePath);
  try {
    await link(readyPath, resolved);
    await assertPrivatePath(resolved);
    return fingerprint;
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
    const winner = (await readFile(resolved, "utf8")).trim().toLowerCase();
    await assertPrivatePath(resolved);
    if (!fingerprintPattern.test(winner)) {
      throw new Error("设备账户身份文件格式不正确");
    }
    return winner;
  } finally {
    await unlink(readyPath).catch(() => undefined);
  }
};

export const readEnrollmentTokenFile = async (
  tokenPath: string,
  assertPrivatePath: PrivatePathCheck = defaultAssertPrivatePath,
): Promise<string> => {
  const resolved = path.resolve(tokenPath);
  const info = await lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("设备接入码必须保存在普通文件中");
  }
  await assertPrivatePath(path.dirname(resolved));
  await assertPrivatePath(resolved);
  const token = (await readFile(resolved, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) {
    throw new Error("设备接入码文件格式不正确");
  }
  return token;
};

const enrollmentResponseSchema = z
  .object({
    data: z
      .object({
        device: z
          .object({
            deviceName: z.string().trim().min(2).max(100),
            accountName: z.string().trim().min(2).max(100),
            status: z.literal("已连接"),
          })
          .strict(),
        connection: WorkerConnectionCredentialSchema,
      })
      .strict(),
  })
  .strict();

const enrollmentConfigSchema = z
  .object({
    capabilities: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9][a-z0-9._-]{0,49}$/u),
      )
      .max(50)
      .default([]),
    mcpConnections: z
      .array(
        z.object({ connectionBindingKey: z.string().uuid() }).passthrough(),
      )
      .max(50)
      .default([]),
  })
  .passthrough();

const safeOrigin = (value: string): string => {
  const url = new URL(value);
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "::1"].includes(url.hostname)
      ))
  ) {
    throw new Error("控制面地址必须使用 HTTPS；本机开发可使用 HTTP");
  }
  return url.origin;
};

export const enrollDeviceWorker = async (options: {
  controlPlaneUrl: string;
  enrollmentToken: string;
  configPath: string;
  identityPath: string;
  fetcher?: typeof fetch;
  assertPrivatePath?: PrivatePathCheck;
}): Promise<void> => {
  const configPath = path.resolve(options.configPath);
  const info = await lstat(configPath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Worker 配置必须是普通文件");
  }
  const assertPrivatePath =
    options.assertPrivatePath ?? defaultAssertPrivatePath;
  await assertPrivatePath(configPath);
  const raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Worker 配置格式不正确");
  }
  const enrollmentConfig = enrollmentConfigSchema.safeParse(raw);
  if (!enrollmentConfig.success) {
    throw new Error("Worker 配置中的设备能力格式不正确");
  }
  const capabilities = [
    ...enrollmentConfig.data.capabilities,
    ...enrollmentConfig.data.mcpConnections.map((connection) =>
      connection.connectionBindingKey.toLowerCase(),
    ),
  ];
  if (
    new Set(capabilities).size !== capabilities.length ||
    capabilities.length > 50
  ) {
    throw new Error("Worker 配置中的设备能力不能重复或超过 50 项");
  }
  const fingerprint = await loadOrCreateAccountFingerprint(
    options.identityPath,
    assertPrivatePath,
  );
  const response = await (options.fetcher ?? fetch)(
    `${safeOrigin(options.controlPlaneUrl)}/api/v1/worker-enrollments/exchange`,
    {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        enrollmentToken: options.enrollmentToken,
        accountFingerprint: fingerprint,
        capabilities,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const text = await readBoundedControlPlaneResponse(response);
  if (!response.ok) {
    throw new Error("设备接入失败，请确认接入码尚未过期");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new Error("控制面返回的设备连接格式不正确");
  }
  const parsed = enrollmentResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("控制面返回的设备连接格式不正确");
  }
  const updated = {
    ...(raw as Record<string, unknown>),
    controlPlaneUrl: safeOrigin(options.controlPlaneUrl),
    connection: parsed.data.data.connection,
  };
  const validatedConfig = DeviceWorkerConfigSchema.safeParse(updated);
  if (!validatedConfig.success) {
    throw new Error(
      "正式连接已签发，但 Worker 配置仍不完整；请修正本机路径与隔离设置后重新签发接入码",
    );
  }
  await writePrivateFile(
    configPath,
    `${JSON.stringify(validatedConfig.data, null, 2)}\n`,
    assertPrivatePath,
  );
};

export const parseEnrollmentArguments = (
  argv: readonly string[],
): {
  controlPlaneUrl: string;
  tokenFile?: string;
  configPath?: string;
  identityPath?: string;
} => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("设备接入命令参数不完整");
    }
    values.set(key, value);
  }
  const controlPlaneUrl = values.get("--control-plane");
  const tokenFile = values.get("--token-file");
  const configPath = values.get("--config");
  const identityPath = values.get("--identity");
  if (!controlPlaneUrl) {
    throw new Error("请提供 --control-plane");
  }
  return {
    controlPlaneUrl,
    ...(tokenFile ? { tokenFile } : {}),
    ...(configPath ? { configPath } : {}),
    ...(identityPath ? { identityPath } : {}),
  };
};
