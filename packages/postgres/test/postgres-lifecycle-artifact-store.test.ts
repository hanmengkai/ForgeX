import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PostgresLifecycleArtifactStore } from "../src/index.js";

const scope = {
  tenantKey: "11111111-1111-4111-8111-111111111111",
  projectKey: "22222222-2222-4222-8222-222222222222",
  repositoryKey: "33333333-3333-4333-8333-333333333333",
};
const content = Buffer.from("测试项目制品");
const envelope = {
  schemaVersion: 1 as const,
  commitSha: "a".repeat(40),
  artifactDigest: createHash("sha256").update(content).digest("hex"),
  bytesBase64: content.toString("base64"),
};
function database(rows: unknown[][]) {
  const client = {
    query: vi.fn(async (_sql: string, _values?: unknown[]) => ({
      rows: rows.shift() ?? [],
    })),
    release: vi.fn(),
  };
  return {
    client,
    store: new PostgresLifecycleArtifactStore({ connect: async () => client }),
  };
}
describe("正式生命周期制品存储", () => {
  it("写入前拒绝错误摘要及非法范围", async () => {
    const { store, client } = database([]);
    await expect(
      store.put(scope, {
        ...envelope,
        bytesBase64: Buffer.from("损坏").toString("base64"),
      }),
    ).rejects.toThrow();
    await expect(
      store.put({ ...scope, tenantKey: "错误" }, envelope),
    ).rejects.toThrow();
    expect(client.query).not.toHaveBeenCalled();
  });
  it("重复上传相同字节幂等，写入包含全部范围及提交", async () => {
    const { store, client } = database([[], [], [{ content }], []]);
    const executorScope = {
      ...scope,
      executorKey: "执行器范围附加字段",
      capabilities: ["development"],
    };
    await store.put(executorScope, envelope);
    expect(client.query.mock.calls[1]?.[1]).toEqual([
      scope.tenantKey,
      scope.projectKey,
      scope.repositoryKey,
      envelope.artifactDigest,
      envelope.commitSha,
      content,
    ]);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });
  it("重复上传遇到损坏已有内容回滚，不能覆盖", async () => {
    const { store, client } = database([
      [],
      [],
      [{ content: Buffer.from("篡改") }],
      [],
    ]);
    await expect(store.put(scope, envelope)).rejects.toThrow();
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });
  it("读取重算摘要，跨范围不存在返回空", async () => {
    const { store, client } = database([
      [{ content }],
      [],
      [{ content: Buffer.from("损坏") }],
    ]);
    expect(
      await store.get(scope, envelope.artifactDigest, envelope.commitSha),
    ).toEqual(envelope);
    expect(
      await store.get(
        { ...scope, repositoryKey: "44444444-4444-4444-8444-444444444444" },
        envelope.artifactDigest,
        envelope.commitSha,
      ),
    ).toBeNull();
    expect(client.query.mock.calls[1]?.[1]?.[2]).toBe(
      "44444444-4444-4444-8444-444444444444",
    );
    await expect(
      store.get(scope, envelope.artifactDigest, envelope.commitSha),
    ).rejects.toThrow();
  });
});
