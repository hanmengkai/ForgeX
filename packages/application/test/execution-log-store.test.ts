import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileSystemExecutionLogStore,
  InMemoryExecutionLogStore,
  type ExecutionLogStore,
} from "../src/execution-log-store.js";

const scope = {
  tenantKey: "11111111-1111-4111-8111-111111111111",
  projectKey: "22222222-2222-4222-8222-222222222222",
  requirementKey: "33333333-3333-4333-8333-333333333333",
  requirementRevision: 2,
};
const assignmentKey = "44444444-4444-4444-8444-444444444444";

const exerciseStore = (
  name: string,
  create: () => Promise<ExecutionLogStore>,
) => {
  describe(name, () => {
    it("尚未产生输出时返回空日志快照", async () => {
      const store = await create();

      await expect(store.readLatest(scope, 300)).resolves.toEqual({
        assignmentKey: null,
        totalLines: 0,
        truncated: false,
        updatedAt: null,
        lines: [],
      });
    });

    it("按最新执行轮次保存日志，默认尾部读取且允许读取全部行", async () => {
      const store = await create();
      const append = (input: {
        chunkKey: string;
        sequence: number;
        occurredAt: string;
        text: string;
      }) =>
        store.append(
          { ...scope, assignmentKey },
          { ...input, stream: "stdout" },
        );

      await expect(
        append({
          chunkKey: "55555555-5555-4555-8555-555555555555",
          sequence: 1,
          occurredAt: "2026-08-14T01:00:00.000Z",
          text: "line-1\nline-2\n",
        }),
      ).resolves.toBe(true);
      await expect(
        append({
          chunkKey: "66666666-6666-4666-8666-666666666666",
          sequence: 2,
          occurredAt: "2026-08-14T01:00:01.000Z",
          text: "line-3\nline-4\n",
        }),
      ).resolves.toBe(true);
      await expect(
        append({
          chunkKey: "66666666-6666-4666-8666-666666666666",
          sequence: 2,
          occurredAt: "2026-08-14T01:00:01.000Z",
          text: "line-3\nline-4\n",
        }),
      ).resolves.toBe(false);

      await expect(store.readLatest(scope, 3)).resolves.toMatchObject({
        assignmentKey,
        totalLines: 4,
        truncated: true,
        lines: [
          { stream: "stdout", text: "line-2" },
          { stream: "stdout", text: "line-3" },
          { stream: "stdout", text: "line-4" },
        ],
      });
      await expect(store.readLatest(scope, null)).resolves.toMatchObject({
        assignmentKey,
        totalLines: 4,
        truncated: false,
        lines: [
          { text: "line-1" },
          { text: "line-2" },
          { text: "line-3" },
          { text: "line-4" },
        ],
      });
    });

    it("新执行轮次开始后不再混入上一轮日志", async () => {
      const store = await create();
      await store.append(
        { ...scope, assignmentKey },
        {
          chunkKey: "77777777-7777-4777-8777-777777777777",
          sequence: 1,
          occurredAt: "2026-08-14T01:00:00.000Z",
          stream: "stderr",
          text: "old failure\n",
        },
      );
      const currentAssignment = "88888888-8888-4888-8888-888888888888";
      await store.append(
        { ...scope, assignmentKey: currentAssignment },
        {
          chunkKey: "99999999-9999-4999-8999-999999999999",
          sequence: 1,
          occurredAt: "2026-08-14T01:05:00.000Z",
          stream: "system",
          text: "new attempt\n",
        },
      );

      await expect(store.readLatest(scope, 300)).resolves.toMatchObject({
        assignmentKey: currentAssignment,
        totalLines: 1,
        lines: [{ stream: "system", text: "new attempt" }],
      });
    });
  });
};

exerciseStore("InMemoryExecutionLogStore", async () =>
  Promise.resolve(new InMemoryExecutionLogStore()),
);

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

exerciseStore("FileSystemExecutionLogStore", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "forgex-execution-log-"));
  temporaryRoots.push(root);
  return new FileSystemExecutionLogStore(root);
});

it("文件系统实现把需求日志持久化为独立日志文件", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "forgex-execution-log-"));
  temporaryRoots.push(root);
  const store = new FileSystemExecutionLogStore(root);
  await store.append(
    { ...scope, assignmentKey },
    {
      chunkKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sequence: 1,
      occurredAt: "2026-08-14T01:00:00.000Z",
      stream: "stdout",
      text: "persisted\n",
    },
  );

  const walk = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true });
    return (
      await Promise.all(
        entries.map((entry) => {
          const target = path.join(directory, entry.name);
          return entry.isDirectory() ? walk(target) : Promise.resolve([target]);
        }),
      )
    ).flat();
  };
  expect((await walk(root)).some((file) => file.endsWith(".log"))).toBe(true);
});
