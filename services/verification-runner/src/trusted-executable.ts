import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { assertDefaultWindowsTrustedPath } from "./windows-path-security.js";

const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;

export type WindowsTrustedPathCheck = (target: string) => Promise<void>;

export { assertDefaultWindowsTrustedPath };

const samePath = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);

const assertPosixTrustedMetadata = (
  metadata: Awaited<ReturnType<typeof lstat>>,
  description: string,
  allowStickyDirectory = false,
): void => {
  const currentUser =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    ((Number(metadata.mode) & 0o022) !== 0 &&
      (!allowStickyDirectory || (Number(metadata.mode) & 0o1000) === 0)) ||
    (currentUser !== undefined &&
      typeof metadata.uid === "number" &&
      metadata.uid !== 0 &&
      metadata.uid !== currentUser)
  ) {
    throw new Error(`${description}不能由其他本机用户改写`);
  }
};

const ancestorDirectories = (target: string): string[] => {
  const directories: string[] = [];
  let current = path.dirname(target);
  while (true) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) return directories;
    current = parent;
  }
};

export const assertTrustedPathAncestors = async (options: {
  targetPath: string;
  description: string;
  assertWindowsTrustedPath?: WindowsTrustedPathCheck;
}): Promise<void> => {
  const check =
    options.assertWindowsTrustedPath ?? assertDefaultWindowsTrustedPath;
  for (const directory of ancestorDirectories(
    path.resolve(options.targetPath),
  )) {
    const directoryMetadata = await lstat(directory);
    if (
      !directoryMetadata.isDirectory() ||
      directoryMetadata.isSymbolicLink() ||
      !samePath(await realpath(directory), directory)
    ) {
      throw new Error(`${options.description}祖先路径不能发生跳转`);
    }
    if (process.platform === "win32") {
      await check(directory);
    } else {
      assertPosixTrustedMetadata(
        directoryMetadata,
        `${options.description}祖先目录`,
        true,
      );
    }
  }
};

export const assertTrustedExecutable = async (options: {
  commandPath: string;
  expectedSha256: string;
  description: string;
  assertWindowsTrustedPath?: WindowsTrustedPathCheck;
}): Promise<void> => {
  const resolved = path.resolve(options.commandPath);
  const [metadata, resolvedRealPath] = await Promise.all([
    lstat(resolved),
    realpath(resolved),
  ]);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !samePath(resolvedRealPath, resolved) ||
    metadata.size < 1 ||
    metadata.size > MAX_EXECUTABLE_BYTES
  ) {
    throw new Error(`${options.description}必须是可信父目录中的普通文件`);
  }
  const check =
    options.assertWindowsTrustedPath ?? assertDefaultWindowsTrustedPath;
  if (process.platform === "win32") {
    await check(resolved);
  } else {
    assertPosixTrustedMetadata(metadata, options.description);
  }
  await assertTrustedPathAncestors({
    targetPath: resolved,
    description: options.description,
    assertWindowsTrustedPath: check,
  });

  let handle;
  try {
    handle = await open(
      resolved,
      process.platform === "win32"
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      openedMetadata.dev !== metadata.dev ||
      openedMetadata.ino !== metadata.ino ||
      openedMetadata.size !== metadata.size ||
      createHash("sha256")
        .update(await handle.readFile())
        .digest("hex") !== options.expectedSha256
    ) {
      throw new Error(`${options.description}摘要与受信配置不一致`);
    }
    const [after, afterRealPath] = await Promise.all([
      lstat(resolved),
      realpath(resolved),
    ]);
    if (
      after.dev !== openedMetadata.dev ||
      after.ino !== openedMetadata.ino ||
      !samePath(afterRealPath, resolved)
    ) {
      throw new Error(`${options.description}在校验期间发生替换`);
    }
  } finally {
    await handle?.close();
  }
};
