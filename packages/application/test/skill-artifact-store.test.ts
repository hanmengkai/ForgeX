import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SkillPackageCodec } from "@forgex/extensions";

import {
  InMemorySkillArtifactStore,
  type SkillArtifactStore,
} from "../src/index.js";

const bytes = SkillPackageCodec.encode({
  schemaVersion: 1,
  instructions: "# 安全发布\n\n发布前检查变更范围和独立验证证据。",
  resources: [],
});
const manifest = {
  schemaVersion: 1 as const,
  skillKey: "33333333-3333-4333-8333-333333333333",
  tenantKey: "11111111-1111-4111-8111-111111111111",
  projectKey: "22222222-2222-4222-8222-222222222222",
  version: "1.0.0",
  name: "安全发布检查",
  summary: "发布前检查变更范围和独立验证证据",
  artifactHashAlgorithm: "sha256" as const,
  artifactHash: createHash("sha256").update(bytes).digest("hex"),
  artifactSizeBytes: bytes.byteLength,
  entrypoint: "SKILL.md" as const,
  compatibleBlueprints: ["Web 应用"],
  requiredCapabilities: ["读取项目文件"],
  permissions: {
    workspace: "read_only" as const,
    network: "none" as const,
    commands: "none" as const,
  },
  createdAt: "2026-08-10T07:00:00.000Z",
};

describe("InMemorySkillArtifactStore", () => {
  it("只保存与清单大小和哈希完全一致的制品，并隔离返回副本", async () => {
    const store: SkillArtifactStore = new InMemorySkillArtifactStore();
    const mutable = Uint8Array.from(bytes);

    await store.put(manifest, mutable);
    mutable[0] = 0;
    const first = await store.get(manifest);
    expect(first).toEqual(Uint8Array.from(bytes));
    first![0] = 0;
    await expect(store.get(manifest)).resolves.toEqual(Uint8Array.from(bytes));
  });

  it("拒绝错误内容，且同一版本只能幂等写入相同制品", async () => {
    const store = new InMemorySkillArtifactStore();

    await expect(store.put(manifest, bytes.slice(1))).rejects.toThrow(
      "Skill 制品大小与清单不一致",
    );
    await store.put(manifest, bytes);
    await expect(store.put(manifest, bytes)).resolves.toBeUndefined();
    await expect(
      store.put(
        {
          ...manifest,
          artifactHash: createHash("sha256")
            .update(
              SkillPackageCodec.encode({
                schemaVersion: 1,
                instructions:
                  "# 被替换的内容\n\n这是另一个格式有效但不允许覆盖的 Skill 包。",
                resources: [],
              }),
            )
            .digest("hex"),
          artifactSizeBytes: SkillPackageCodec.encode({
            schemaVersion: 1,
            instructions:
              "# 被替换的内容\n\n这是另一个格式有效但不允许覆盖的 Skill 包。",
            resources: [],
          }).byteLength,
        },
        SkillPackageCodec.encode({
          schemaVersion: 1,
          instructions:
            "# 被替换的内容\n\n这是另一个格式有效但不允许覆盖的 Skill 包。",
          resources: [],
        }),
      ),
    ).rejects.toThrow("同一版本的 Skill 制品不能被覆盖");
  });
});
