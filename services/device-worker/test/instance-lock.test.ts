import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import path from "node:path";

import {
  DeviceWorkerInstanceLock,
  uniqueLockIdentityForTest,
} from "../src/instance-lock.js";

const locks: DeviceWorkerInstanceLock[] = [];

afterEach(async () => {
  for (const lock of locks.splice(0)) await lock.release();
});

describe("DeviceWorkerInstanceLock", () => {
  it.skipIf(process.platform !== "darwin")(
    "macOS 私有临时目录过长时仍能取得同一账户的单实例锁",
    async () => {
      const root = await mkdtemp(
        path.join(await realpath("/tmp"), "forgex-long-temp-"),
      );
      const longDirectory = path.join(root, "private-session-".repeat(8));
      await mkdir(longDirectory);
      try {
        vi.stubEnv("TMPDIR", longDirectory);
        const identity = uniqueLockIdentityForTest();
        const lock = await DeviceWorkerInstanceLock.acquire(identity);
        locks.push(lock);
        await expect(
          DeviceWorkerInstanceLock.acquire(identity),
        ).rejects.toThrow("已经有一个 Worker 实例");
      } finally {
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("同一设备账户同时只允许一个 Worker 进程", async () => {
    const identity = uniqueLockIdentityForTest();
    const first = await DeviceWorkerInstanceLock.acquire(identity);
    locks.push(first);

    await expect(DeviceWorkerInstanceLock.acquire(identity)).rejects.toThrow(
      "已经有一个 Worker 实例",
    );
    await first.release();
    locks.splice(locks.indexOf(first), 1);
    const next = await DeviceWorkerInstanceLock.acquire(identity);
    locks.push(next);
  });
});
