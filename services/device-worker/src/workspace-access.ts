import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_FILE_BYTES = 1_048_576;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_FILES = 5_000;
const MAX_SEARCH_BYTES = 20 * 1024 * 1024;

const samePath = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;

const isInside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const safeRelativePath = (value: string): string => {
  if (
    value.length > 500 ||
    value.includes("\u0000") ||
    path.isAbsolute(value) ||
    value.split(/[\\/]/u).some((segment) => segment === "..")
  ) {
    throw new Error("只能读取当前工作树内的相对路径");
  }
  return value === "" || value === "." ? "." : path.normalize(value);
};

const safeExampleSuffix = /(?:\.example|\.sample|\.template)$/iu;
const sensitiveName =
  /(?:^|[._-])(?:\.env|api[-_]?key|auth|client[-_]?secret|credential|credentials|password|passwd|private[-_]?key|secret|secrets|token|tokens)(?:$|[._-])/iu;
const sensitiveExtension = /\.(?:key|pem|p12|pfx|jks|keystore)$/iu;
const sensitiveExactName =
  /^(?:\.netrc|\.npmrc|\.pypirc|apikey|accesstoken|clientsecret|id_dsa|id_ecdsa|id_ed25519|id_rsa|password|passwd|privatekey|refreshtoken|secret)$/iu;
const windowsReservedName =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

const assertReadableBusinessPath = (relativePath: string): void => {
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    segments.some((segment) =>
      [".git", ".codex"].includes(segment.toLowerCase()),
    ) ||
    segments.some((segment, index) => {
      const safeExample =
        index === segments.length - 1 && safeExampleSuffix.test(segment);
      return (
        segment.includes(":") ||
        /[. ]$/u.test(segment) ||
        windowsReservedName.test(segment) ||
        (!safeExample &&
          (sensitiveName.test(segment) || sensitiveExactName.test(segment))) ||
        sensitiveExtension.test(segment)
      );
    })
  ) {
    throw new Error(
      "该路径可能包含凭据或 Git 内部数据，设备不会把它提供给 Codex",
    );
  }
};

const textFile = (value: Buffer): string => {
  if (value.includes(0)) throw new Error("当前只支持读取文本文件");
  return value.toString("utf8");
};

export class WorkspaceAccess {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  static async open(root: string): Promise<WorkspaceAccess> {
    const resolved = path.normalize(path.resolve(root));
    const metadata = await lstat(resolved);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Codex 工作树必须是不可跳转的本地目录");
    }
    const actual = path.normalize(await realpath(resolved));
    if (!samePath(actual, resolved)) {
      throw new Error("Codex 工作树不能经过符号链接或目录跳转");
    }
    return new WorkspaceAccess(actual);
  }

  async readFile(input: {
    path: string;
    startLine?: number;
    maxLines?: number;
  }): Promise<string> {
    const relativePath = safeRelativePath(input.path);
    assertReadableBusinessPath(relativePath);
    const target = await this.#regularFile(relativePath);
    const value = textFile(await readFile(target));
    const lines = value.split(/\r?\n/u);
    const startLine = input.startLine ?? 1;
    const maxLines = input.maxLines ?? 300;
    const selected = lines.slice(startLine - 1, startLine - 1 + maxLines);
    return selected
      .map((line, index) => `${startLine + index}: ${line}`)
      .join("\n");
  }

  async list(input: { path?: string; depth?: number }): Promise<string> {
    const relativePath = safeRelativePath(input.path ?? ".");
    if (relativePath !== ".") assertReadableBusinessPath(relativePath);
    const root = await this.#directory(relativePath);
    const depth = input.depth ?? 2;
    const entries: string[] = [];

    const visit = async (
      directory: string,
      relative: string,
      level: number,
    ) => {
      const children = [];
      const handle = await opendir(directory);
      for await (const child of handle) {
        children.push(child);
        if (children.length >= MAX_LIST_ENTRIES - entries.length) break;
      }
      children.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
      for (const child of children) {
        if (entries.length >= MAX_LIST_ENTRIES) return;
        const childRelative =
          relative === "." ? child.name : path.join(relative, child.name);
        try {
          assertReadableBusinessPath(childRelative);
        } catch {
          entries.push(`${childRelative.replaceAll("\\", "/")} [受保护]`);
          continue;
        }
        if (child.isSymbolicLink()) {
          entries.push(
            `${childRelative.replaceAll("\\", "/")} [符号链接已忽略]`,
          );
          continue;
        }
        entries.push(
          `${childRelative.replaceAll("\\", "/")}${child.isDirectory() ? "/" : ""}`,
        );
        if (child.isDirectory() && level < depth) {
          await visit(
            path.join(directory, child.name),
            childRelative,
            level + 1,
          );
        }
      }
    };

    await visit(root, relativePath, 1);
    if (entries.length === MAX_LIST_ENTRIES)
      entries.push("…列表已达到安全上限");
    return entries.join("\n") || "当前目录为空";
  }

  async search(input: {
    query: string;
    path?: string;
    caseSensitive?: boolean;
    maxMatches?: number;
  }): Promise<string> {
    const relativePath = safeRelativePath(input.path ?? ".");
    if (relativePath !== ".") assertReadableBusinessPath(relativePath);
    const requestedTarget = path.resolve(this.#root, relativePath);
    if (!isInside(this.#root, requestedTarget)) {
      throw new Error("只能搜索当前工作树内的路径");
    }
    const metadata = await lstat(requestedTarget);
    if (metadata.isSymbolicLink()) {
      throw new Error("不能通过符号链接搜索工作树外内容");
    }
    const target = metadata.isFile()
      ? await this.#regularFile(relativePath)
      : metadata.isDirectory()
        ? await this.#directory(relativePath)
        : requestedTarget;
    const files: Array<{ absolute: string; relative: string; size: number }> =
      [];
    let totalBytes = 0;

    const collect = async (
      absolute: string,
      relative: string,
    ): Promise<void> => {
      if (files.length >= MAX_SEARCH_FILES || totalBytes >= MAX_SEARCH_BYTES)
        return;
      const current = await lstat(absolute);
      if (current.isSymbolicLink()) return;
      if (current.isFile()) {
        assertReadableBusinessPath(relative);
        if (current.size > MAX_FILE_BYTES) return;
        files.push({ absolute, relative, size: current.size });
        totalBytes += current.size;
        return;
      }
      if (!current.isDirectory()) return;
      const directory = await opendir(absolute);
      for await (const child of directory) {
        if (files.length >= MAX_SEARCH_FILES || totalBytes >= MAX_SEARCH_BYTES)
          return;
        const childRelative =
          relative === "." ? child.name : path.join(relative, child.name);
        try {
          assertReadableBusinessPath(childRelative);
        } catch {
          continue;
        }
        if (!child.isSymbolicLink()) {
          await collect(path.join(absolute, child.name), childRelative);
        }
      }
    };

    if (metadata.isFile()) {
      await collect(target, relativePath);
    } else if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      await collect(target, relativePath);
    } else {
      throw new Error("搜索范围必须是当前工作树内的普通文件或目录");
    }

    const maxMatches = input.maxMatches ?? 100;
    const needle = input.caseSensitive
      ? input.query
      : input.query.toLowerCase();
    const matches: string[] = [];
    for (const file of files) {
      if (matches.length >= maxMatches) break;
      let value: string;
      try {
        value = textFile(await readFile(file.absolute));
      } catch {
        continue;
      }
      value.split(/\r?\n/u).forEach((line, index) => {
        if (matches.length >= maxMatches) return;
        const haystack = input.caseSensitive ? line : line.toLowerCase();
        if (haystack.includes(needle)) {
          matches.push(
            `${file.relative.replaceAll("\\", "/")}:${index + 1}: ${line.slice(0, 500)}`,
          );
        }
      });
    }
    return matches.join("\n") || "没有找到匹配内容";
  }

  async #regularFile(relativePath: string): Promise<string> {
    const target = path.resolve(this.#root, relativePath);
    const metadata = await lstat(target);
    if (
      !isInside(this.#root, target) ||
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_FILE_BYTES
    ) {
      throw new Error("只能读取当前工作树内不超过 1 MiB 的普通文件");
    }
    const actual = path.normalize(await realpath(target));
    if (!isInside(this.#root, actual)) {
      throw new Error("不能通过符号链接读取工作树外文件");
    }
    return actual;
  }

  async #directory(relativePath: string): Promise<string> {
    const target = path.resolve(this.#root, relativePath);
    const metadata = await lstat(target);
    if (
      !isInside(this.#root, target) ||
      !metadata.isDirectory() ||
      metadata.isSymbolicLink()
    ) {
      throw new Error("只能列出当前工作树内的普通目录");
    }
    const actual = path.normalize(await realpath(target));
    if (!isInside(this.#root, actual)) {
      throw new Error("不能通过符号链接列出工作树外目录");
    }
    return actual;
  }
}
