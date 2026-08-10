import { afterEach, describe, expect, it } from "vitest";

import {
  DeviceWorkerInstanceLock,
  uniqueLockIdentityForTest,
} from "../src/instance-lock.js";

const locks: DeviceWorkerInstanceLock[] = [];

afterEach(async () => {
  for (const lock of locks.splice(0)) await lock.release();
});

describe("DeviceWorkerInstanceLock", () => {
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
