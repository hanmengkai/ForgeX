import { createHash, timingSafeEqual } from "node:crypto";

const internalKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

export interface PreviewArtifactReference {
  tenantKey: string;
  projectKey: string;
  requirementKey: string;
  requirementRevision: number;
  artifactHashAlgorithm: "sha256";
  artifactHash: string;
}

export interface PreviewArtifact extends PreviewArtifactReference {
  content: Uint8Array;
}

export interface PreviewArtifactStore {
  put(artifact: PreviewArtifact): Promise<void>;
  get(reference: PreviewArtifactReference): Promise<PreviewArtifact | null>;
}

export interface InMemoryPreviewArtifactStoreOptions {
  maxArtifactBytes?: number;
}

const normalizeReference = (
  reference: PreviewArtifactReference,
): PreviewArtifactReference => {
  const tenantKey = reference.tenantKey.trim().toLowerCase();
  const projectKey = reference.projectKey.trim().toLowerCase();
  const requirementKey = reference.requirementKey.trim().toLowerCase();
  if (
    !internalKeyPattern.test(tenantKey) ||
    !internalKeyPattern.test(projectKey) ||
    !internalKeyPattern.test(requirementKey) ||
    !Number.isSafeInteger(reference.requirementRevision) ||
    reference.requirementRevision < 1 ||
    reference.artifactHashAlgorithm !== "sha256" ||
    !sha256Pattern.test(reference.artifactHash)
  ) {
    throw new Error("Preview 制品引用无效");
  }
  return {
    tenantKey,
    projectKey,
    requirementKey,
    requirementRevision: reference.requirementRevision,
    artifactHashAlgorithm: "sha256",
    artifactHash: reference.artifactHash,
  };
};

const referenceKey = (reference: PreviewArtifactReference): string =>
  [
    reference.tenantKey,
    reference.projectKey,
    reference.requirementKey,
    String(reference.requirementRevision),
    reference.artifactHash,
  ].join(":");

const sha256 = (content: Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength &&
  timingSafeEqual(Buffer.from(left), Buffer.from(right));

export class InMemoryPreviewArtifactStore implements PreviewArtifactStore {
  readonly #artifacts = new Map<string, PreviewArtifact>();
  readonly #maxArtifactBytes: number;

  constructor(options: InMemoryPreviewArtifactStoreOptions = {}) {
    const maxArtifactBytes =
      options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1) {
      throw new Error("Preview 制品大小上限无效");
    }
    this.#maxArtifactBytes = maxArtifactBytes;
  }

  async put(artifact: PreviewArtifact): Promise<void> {
    const reference = normalizeReference(artifact);
    if (!(artifact.content instanceof Uint8Array)) {
      throw new Error("Preview 制品必须使用字节内容");
    }
    if (
      artifact.content.byteLength < 1 ||
      artifact.content.byteLength > this.#maxArtifactBytes
    ) {
      throw new Error("Preview 制品超过大小上限");
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(artifact.content);
    } catch {
      throw new Error("Preview 制品必须是有效的 UTF-8 HTML");
    }
    if (sha256(artifact.content) !== reference.artifactHash) {
      throw new Error("Preview 制品摘要与实际字节不一致");
    }

    const key = referenceKey(reference);
    const existing = this.#artifacts.get(key);
    if (existing) {
      if (!equalBytes(existing.content, artifact.content)) {
        throw new Error("内容寻址的 Preview 制品不可覆盖");
      }
      return;
    }
    this.#artifacts.set(key, {
      ...reference,
      content: artifact.content.slice(),
    });
  }

  async get(
    requestedReference: PreviewArtifactReference,
  ): Promise<PreviewArtifact | null> {
    const reference = normalizeReference(requestedReference);
    const artifact = this.#artifacts.get(referenceKey(reference));
    if (!artifact) return null;
    if (sha256(artifact.content) !== artifact.artifactHash) {
      throw new Error("Preview 制品完整性校验失败");
    }
    return { ...artifact, content: artifact.content.slice() };
  }
}
