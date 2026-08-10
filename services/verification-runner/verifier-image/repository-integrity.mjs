import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_FILES = 20_000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const sourceExtension = /\.(?:cjs|js|jsx|mjs|ts|tsx)$/iu;

const isForbiddenName = (name) => {
  const normalized = name.toLowerCase();
  if (normalized === ".env.example" || normalized.endsWith(".example.json")) {
    return false;
  }
  return (
    normalized === ".env" ||
    normalized.startsWith(".env.") ||
    normalized === "auth.json" ||
    normalized === "account.identity" ||
    normalized === "id_rsa" ||
    normalized === "id_ed25519" ||
    normalized.endsWith(".pem") ||
    normalized.endsWith(".key") ||
    normalized.endsWith("journal.json") ||
    normalized.endsWith(".config.json")
  );
};

const parseJsonObject = async (filePath, label) => {
  let value;
  try {
    value = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error(`${label}不是有效 JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}必须是 JSON 对象`);
  }
  return value;
};

export const verifyRepositoryIntegrity = async (rootInput) => {
  if (typeof rootInput !== "string" || !path.isAbsolute(rootInput)) {
    throw new Error("候选仓库必须使用绝对路径");
  }
  const root = path.resolve(rootInput);
  const [rootMetadata, rootRealPath] = await Promise.all([
    lstat(root),
    realpath(root),
  ]);
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    path.resolve(rootRealPath) !== root
  ) {
    throw new Error("候选仓库必须是不跳转的普通目录");
  }

  let inspectedFiles = 0;
  let inspectedEntries = 0;
  let inspectedBytes = 0;
  let sourceFiles = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await opendir(directory);
    for await (const entry of entries) {
      inspectedEntries += 1;
      if (inspectedEntries > MAX_FILES) {
        throw new Error("候选仓库超过独立验证的文件边界");
      }
      const candidatePath = path.join(directory, entry.name);
      const metadata = await lstat(candidatePath);
      if (metadata.isSymbolicLink()) {
        throw new Error("候选仓库不能包含符号链接");
      }
      if (entry.name === "node_modules") {
        throw new Error("候选仓库不能提交 node_modules");
      }
      if (entry.name === ".git") {
        if (directory !== root || !metadata.isFile()) {
          throw new Error("候选仓库只能在根目录包含 Git 工作树管理文件");
        }
        continue;
      }
      if (isForbiddenName(entry.name)) {
        throw new Error("候选仓库包含禁止进入验证制品的敏感文件");
      }
      if (metadata.isDirectory()) {
        pending.push(candidatePath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error("候选仓库只能包含普通文件和目录");
      }
      inspectedFiles += 1;
      inspectedBytes += metadata.size;
      if (
        inspectedFiles > MAX_FILES ||
        metadata.size > MAX_FILE_BYTES ||
        inspectedBytes > MAX_TOTAL_BYTES
      ) {
        throw new Error("候选仓库超过独立验证的文件边界");
      }
      if (sourceExtension.test(entry.name)) sourceFiles += 1;
    }
  }

  const manifest = await parseJsonObject(
    path.join(root, "package.json"),
    "候选 package.json",
  );
  const lockfile = await parseJsonObject(
    path.join(root, "package-lock.json"),
    "候选 package-lock.json",
  );
  const tsconfig = await parseJsonObject(
    path.join(root, "tsconfig.json"),
    "候选 tsconfig.json",
  );
  let strictTypeChecking =
    typeof tsconfig.compilerOptions === "object" &&
    tsconfig.compilerOptions !== null &&
    tsconfig.compilerOptions.strict === true;
  if (!strictTypeChecking) {
    try {
      const baseConfig = await parseJsonObject(
        path.join(root, "tsconfig.base.json"),
        "候选 tsconfig.base.json",
      );
      strictTypeChecking =
        typeof baseConfig.compilerOptions === "object" &&
        baseConfig.compilerOptions !== null &&
        baseConfig.compilerOptions.strict === true;
    } catch {
      strictTypeChecking = false;
    }
  }
  if (
    typeof manifest.name !== "string" ||
    manifest.name.length < 1 ||
    manifest.name.length > 214 ||
    lockfile.name !== manifest.name ||
    lockfile.lockfileVersion !== 3 ||
    !strictTypeChecking ||
    sourceFiles < 1
  ) {
    throw new Error("候选仓库没有满足固定的 Node.js 完整性基线");
  }

  return {
    packageName: manifest.name,
    sourceFiles,
    inspectedFiles,
    inspectedBytes,
  };
};
