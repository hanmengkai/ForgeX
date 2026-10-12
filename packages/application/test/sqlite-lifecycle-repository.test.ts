import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SqliteLifecycleRepository } from "../src/sqlite-lifecycle-repository.js";

describe("隔离控制面持久化", () => {
  it("拒绝公共目录和损坏状态，串行事务不丢并发更新", async () => {
    const root = await mkdtemp(
        path.join(os.tmpdir(), "forgex-state-boundary-"),
      ),
      file = path.join(root, "state.sqlite"),
      tenant = randomUUID();
    const repo = await SqliteLifecycleRepository.open(file);
    try {
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          repo.transaction(tenant, async (state) => {
            await Promise.resolve();
            state.readNotifications.push({
              actorKey: randomUUID(),
              eventKey: randomUUID(),
            });
            return i;
          }),
        ),
      );
      expect(
        await repo.transaction(tenant, (s) => s.readNotifications.length),
      ).toBe(10);
      repo.database
        .prepare("UPDATE lifecycle_states SET state=? WHERE tenant_key=?")
        .run('{"schemaVersion":99}', tenant);
      await expect(repo.transaction(tenant, (s) => s)).rejects.toThrow();
      repo.close();
      if (process.platform !== "win32") {
        await chmod(root, 0o755);
        await expect(
          SqliteLifecycleRepository.open(path.join(root, "public.sqlite")),
        ).rejects.toThrow("私有目录");
        await chmod(root, 0o700);
      }
      await writeFile(path.join(root, "corrupt.sqlite"), "损坏数据库", {
        mode: 0o600,
      });
      await expect(
        SqliteLifecycleRepository.open(path.join(root, "corrupt.sqlite")),
      ).rejects.toThrow();
    } finally {
      repo.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("重建实例保留事务，失败回滚，租户隔离且拒绝宽权限数据库", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-state-"));
    const file = path.join(root, "lifecycle.sqlite"),
      tenant = randomUUID();
    let repo = await SqliteLifecycleRepository.open(file);
    try {
      await repo.transaction(tenant, (state) => {
        state.readNotifications.push({
          actorKey: randomUUID(),
          eventKey: randomUUID(),
        });
      });
      await expect(
        repo.transaction(tenant, (state) => {
          state.readNotifications.length = 0;
          throw new Error("中断审批");
        }),
      ).rejects.toThrow("中断审批");
      repo.close();
      repo = await SqliteLifecycleRepository.open(file);
      expect(
        await repo.transaction(tenant, (s) => s.readNotifications.length),
      ).toBe(1);
      expect(
        await repo.transaction(randomUUID(), (s) => s.readNotifications.length),
      ).toBe(0);
      repo.close();
      if (process.platform !== "win32") {
        await chmod(file, 0o644);
        await expect(SqliteLifecycleRepository.open(file)).rejects.toThrow(
          "私有",
        );
      }
    } finally {
      repo.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
