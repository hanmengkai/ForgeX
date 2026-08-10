import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyRepositoryIntegrity } from "../verifier-image/repository-integrity.mjs";

const roots: string[] = [];

const fixture = async () => {
  const root = path.join(os.tmpdir(), `forgex-verifier-${crypto.randomUUID()}`);
  roots.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "candidate", version: "1.0.0" }),
    ),
    writeFile(
      path.join(root, "package-lock.json"),
      JSON.stringify({ name: "candidate", lockfileVersion: 3 }),
    ),
    writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    ),
    writeFile(
      path.join(root, "src", "index.ts"),
      "export const ready = true;\n",
    ),
  ]);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("repository integrity verifier", () => {
  it("只读取候选文件并验证锁文件、严格类型配置和源码边界", async () => {
    const root = await fixture();

    await expect(verifyRepositoryIntegrity(root)).resolves.toMatchObject({
      packageName: "candidate",
      sourceFiles: 1,
    });
  });

  it("拒绝候选中的凭据文件和符号链接", async () => {
    const secretRoot = await fixture();
    await writeFile(path.join(secretRoot, ".env"), "TOKEN=secret\n");
    await expect(verifyRepositoryIntegrity(secretRoot)).rejects.toThrow(
      "候选仓库包含禁止进入验证制品的敏感文件",
    );

    const symlinkRoot = await fixture();
    await symlink(
      path.join(symlinkRoot, "src"),
      path.join(symlinkRoot, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(verifyRepositoryIntegrity(symlinkRoot)).rejects.toThrow(
      "候选仓库不能包含符号链接",
    );
  });

  it("拒绝提交依赖目录或嵌套 Git 元数据来绕过完整扫描", async () => {
    const dependencyRoot = await fixture();
    await mkdir(path.join(dependencyRoot, "node_modules", "fixture"), {
      recursive: true,
    });
    await writeFile(
      path.join(dependencyRoot, "node_modules", "fixture", "secret.pem"),
      "not-a-real-secret",
    );
    await expect(verifyRepositoryIntegrity(dependencyRoot)).rejects.toThrow(
      "候选仓库不能提交 node_modules",
    );

    const nestedGitRoot = await fixture();
    await mkdir(path.join(nestedGitRoot, "src", "feature", ".git"), {
      recursive: true,
    });
    await writeFile(
      path.join(nestedGitRoot, "src", "feature", ".git", "config"),
      "[core]",
    );
    await expect(verifyRepositoryIntegrity(nestedGitRoot)).rejects.toThrow(
      "候选仓库只能在根目录包含 Git 工作树管理文件",
    );
  });

  it("不执行候选 package scripts", async () => {
    const root = await fixture();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "candidate",
        version: "1.0.0",
        scripts: { test: "exit 0" },
      }),
    );

    const result = await verifyRepositoryIntegrity(root);
    expect(result).not.toHaveProperty("executedScripts");
  });
});
