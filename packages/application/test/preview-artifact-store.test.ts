import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { InMemoryPreviewArtifactStore } from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const requirementKey = "33333333-3333-4333-8333-333333333333";

const content = new TextEncoder().encode(
  '<!doctype html><meta charset="utf-8"><h1>访客预约</h1>',
);
const artifactHash = createHash("sha256").update(content).digest("hex");
const reference = {
  tenantKey,
  projectKey,
  requirementKey,
  requirementRevision: 2,
  artifactHashAlgorithm: "sha256" as const,
  artifactHash,
};

describe("InMemoryPreviewArtifactStore", () => {
  it("按实际响应字节校验并隔离保存内容寻址的 Preview", async () => {
    const store = new InMemoryPreviewArtifactStore();

    await store.put({ ...reference, content });
    content.fill(0);

    const artifact = await store.get(reference);
    expect(new TextDecoder().decode(artifact?.content)).toContain("访客预约");
    artifact?.content.fill(0);
    expect(
      new TextDecoder().decode((await store.get(reference))?.content),
    ).toContain("访客预约");
    await expect(
      store.get({
        ...reference,
        projectKey: "44444444-4444-4444-8444-444444444444",
      }),
    ).resolves.toBeNull();
  });

  it("拒绝摘要与字节不一致、无效编码和过大的制品", async () => {
    const store = new InMemoryPreviewArtifactStore({
      maxArtifactBytes: 64,
    });

    await expect(
      store.put({
        ...reference,
        artifactHash: createHash("sha256")
          .update(new Uint8Array())
          .digest("hex"),
        content: new Uint8Array(),
      }),
    ).rejects.toThrow("Preview 制品超过大小上限");

    await expect(
      store.put({
        ...reference,
        content: new TextEncoder().encode("被替换的内容"),
      }),
    ).rejects.toThrow("Preview 制品摘要与实际字节不一致");
    await expect(
      store.put({
        ...reference,
        artifactHash: createHash("sha256")
          .update(Uint8Array.from([0xff]))
          .digest("hex"),
        content: Uint8Array.from([0xff]),
      }),
    ).rejects.toThrow("Preview 制品必须是有效的 UTF-8 HTML");
    const oversized = new Uint8Array(65);
    await expect(
      store.put({
        ...reference,
        artifactHash: createHash("sha256").update(oversized).digest("hex"),
        content: oversized,
      }),
    ).rejects.toThrow("Preview 制品超过大小上限");
  });

  it("同一内容寻址键只接受字节完全一致的幂等写入", async () => {
    const store = new InMemoryPreviewArtifactStore();
    const original = new TextEncoder().encode("<h1>不可变预览</h1>");
    const immutableReference = {
      ...reference,
      artifactHash: createHash("sha256").update(original).digest("hex"),
    };

    await store.put({ ...immutableReference, content: original });
    await expect(
      store.put({ ...immutableReference, content: original.slice() }),
    ).resolves.toBeUndefined();
  });
});
