import { createHash } from "node:crypto";

import {
  SkillPackageCodec,
  SkillPackageManifestSchema,
  type SkillPackageManifest,
} from "@forgex/extensions";

export interface SkillArtifactStore {
  put(manifest: SkillPackageManifest, bytes: Uint8Array): Promise<void>;
  get(manifest: SkillPackageManifest): Promise<Uint8Array | null>;
}

const artifactKey = (manifest: SkillPackageManifest): string =>
  [
    manifest.tenantKey,
    manifest.projectKey,
    manifest.skillKey,
    manifest.version,
  ].join(":");

export const verifySkillArtifactBytes = (
  manifestInput: SkillPackageManifest,
  input: Uint8Array,
): Uint8Array => {
  const manifest = SkillPackageManifestSchema.parse(manifestInput);
  const bytes = Uint8Array.from(input);
  if (bytes.byteLength !== manifest.artifactSizeBytes) {
    throw new Error("Skill 制品大小与清单不一致");
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== manifest.artifactHash) {
    throw new Error("Skill 制品内容与清单哈希不一致");
  }
  SkillPackageCodec.decode(bytes);
  return bytes;
};

export class InMemorySkillArtifactStore implements SkillArtifactStore {
  readonly #artifacts = new Map<string, Uint8Array>();

  async put(
    manifestInput: SkillPackageManifest,
    input: Uint8Array,
  ): Promise<void> {
    const manifest = SkillPackageManifestSchema.parse(manifestInput);
    const bytes = verifySkillArtifactBytes(manifest, input);
    const key = artifactKey(manifest);
    const existing = this.#artifacts.get(key);
    if (existing) {
      if (Buffer.from(existing).equals(Buffer.from(bytes))) return;
      throw new Error("同一版本的 Skill 制品不能被覆盖");
    }
    this.#artifacts.set(key, Uint8Array.from(bytes));
  }

  async get(manifestInput: SkillPackageManifest): Promise<Uint8Array | null> {
    const manifest = SkillPackageManifestSchema.parse(manifestInput);
    const stored = this.#artifacts.get(artifactKey(manifest));
    return stored
      ? Uint8Array.from(verifySkillArtifactBytes(manifest, stored))
      : null;
  }
}
