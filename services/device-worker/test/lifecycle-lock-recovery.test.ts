import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { describe, it, expect } from "vitest";
import { FileLifecycleJournal } from "../src/lifecycle-runtime.js";

describe("执行器强制停止后的锁恢复", () => {
  it("内核释放 SQLite 锁后自动恢复，同时拒绝活着的持有者", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-crash-lock-"));
    await writeFile(path.join(root, "executor-lock.sqlite"), "", {
      mode: 0o600,
    });
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN EXCLUSIVE');console.log('ready');setInterval(()=>{},1000);`,
        path.join(root, "executor-lock.sqlite"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await once(child.stdout!, "data");
      await expect(new FileLifecycleJournal(root).acquire()).rejects.toThrow(
        "已有持有者",
      );
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      const release = await new FileLifecycleJournal(root).acquire();
      await release();
      await writeFile(
        path.join(root, "executor.lock"),
        JSON.stringify({ pid: process.pid, token: "旧版锁" }),
        { mode: 0o600 },
      );
      await expect(new FileLifecycleJournal(root).acquire()).rejects.toThrow(
        "旧版",
      );
      expect(true).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  });
});
