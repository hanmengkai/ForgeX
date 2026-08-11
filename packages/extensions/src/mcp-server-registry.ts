import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

import { z } from "zod";

const internalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const humanLabel = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .refine(
    (value) =>
      !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u.test(
        value,
      ),
    "业务名称不能包含隐藏控制字符",
  );
const businessName = humanLabel.refine(
  (value) => !/^[a-z][a-z0-9_.-]*(?:\(\))?$/i.test(value),
  "请使用业务名称，不要只填写技术标识",
);
const humanDescription = z
  .string()
  .trim()
  .min(4)
  .max(500)
  .refine(
    (value) =>
      !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u.test(
        value,
      ),
    "业务说明不能包含隐藏控制字符",
  );
const sha256Hash = z.string().regex(/^[0-9a-f]{64}$/);
const technicalName = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);

const McpToolDefinitionSchema = z
  .object({
    toolKey: internalKey,
    technicalName,
    displayName: businessName,
    description: humanDescription,
    effect: z.enum(["read", "write", "external_action"]),
    approval: z.enum(["automatic", "review_required"]),
    inputSchemaHashAlgorithm: z.literal("sha256"),
    inputSchemaHash: sha256Hash,
  })
  .strict()
  .superRefine((tool, context) => {
    if (tool.effect !== "read" && tool.approval === "automatic") {
      context.addIssue({
        code: "custom",
        path: ["approval"],
        message: "写入和外部动作必须经过人工确认",
      });
    }
  });

export const McpServerManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    serverKey: internalKey,
    tenantKey: internalKey,
    projectKey: internalKey,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    name: businessName,
    summary: humanDescription,
    transport: z.enum(["stdio", "streamable_http"]),
    connectionBindingKey: internalKey,
    protocolVersion: z.string().regex(/^20\d{2}-\d{2}-\d{2}$/),
    tools: z.array(McpToolDefinitionSchema).min(1).max(50),
    publishedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const keys = new Set<string>();
    const technicalNames = new Set<string>();
    const displayNames = new Set<string>();
    manifest.tools.forEach((tool, index) => {
      const normalizedTechnicalName = tool.technicalName.toLowerCase();
      const normalizedDisplayName = tool.displayName.toLowerCase();
      if (keys.has(tool.toolKey)) {
        context.addIssue({
          code: "custom",
          path: ["tools", index, "toolKey"],
          message: "MCP 业务能力标识不能重复",
        });
      }
      if (technicalNames.has(normalizedTechnicalName)) {
        context.addIssue({
          code: "custom",
          path: ["tools", index, "technicalName"],
          message: "MCP 工具名称不能重复",
        });
      }
      if (displayNames.has(normalizedDisplayName)) {
        context.addIssue({
          code: "custom",
          path: ["tools", index, "displayName"],
          message: "MCP 业务能力名称不能重复",
        });
      }
      keys.add(tool.toolKey);
      technicalNames.add(normalizedTechnicalName);
      displayNames.add(normalizedDisplayName);
    });
  });

export type McpServerManifest = z.infer<typeof McpServerManifestSchema>;
export type McpToolDefinition = z.infer<typeof McpToolDefinitionSchema>;

const ObservedMcpToolSchema = z
  .object({
    technicalName,
    inputSchemaHashAlgorithm: z.literal("sha256"),
    inputSchemaHash: sha256Hash,
  })
  .strict();

export const McpHealthPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    attestationKey: internalKey,
    probeSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    previousAttestationKey: internalKey.nullable(),
    tenantKey: internalKey,
    projectKey: internalKey,
    serverKey: internalKey,
    serverRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    manifestHashAlgorithm: z.literal("sha256"),
    manifestHash: sha256Hash,
    verifierKey: internalKey,
    keyId: internalKey,
    serverIdentityHashAlgorithm: z.literal("sha256"),
    serverIdentityHash: sha256Hash,
    protocolVersion: z.string().regex(/^20\d{2}-\d{2}-\d{2}$/),
    observedTools: z.array(ObservedMcpToolSchema).max(50),
    status: z.enum(["healthy", "unhealthy"]),
    recoveryChallengeKey: internalKey.nullable(),
    producedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.status === "healthy" && payload.observedTools.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["observedTools"],
        message: "健康探测必须包含服务器实际能力",
      });
    }
    const names = new Set<string>();
    payload.observedTools.forEach((tool, index) => {
      const name = tool.technicalName.toLowerCase();
      if (names.has(name)) {
        context.addIssue({
          code: "custom",
          path: ["observedTools", index, "technicalName"],
          message: "MCP 探测结果不能包含重复工具",
        });
      }
      names.add(name);
    });
  });

export type McpHealthPayload = z.infer<typeof McpHealthPayloadSchema>;

const canonicalBase64Signature = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length !== 64 || bytes.toString("base64") !== value) {
      context.addIssue({ code: "custom", message: "MCP 探测签名格式无效" });
    }
  });

export const SignedMcpHealthAttestationSchema = z
  .object({
    payload: McpHealthPayloadSchema,
    signature: canonicalBase64Signature,
  })
  .strict();

export type SignedMcpHealthAttestation = z.infer<
  typeof SignedMcpHealthAttestationSchema
>;

export interface McpVerifierScope {
  tenantKey: string;
  projectKey: string;
}

export interface TrustedMcpVerifier {
  verifierKey: string;
  keyId: string;
  verifierName: string;
  publicKeyBase64: string;
  scopes: McpVerifierScope[];
  acceptNewAttestations?: boolean;
}

export interface McpHealthAuthorityOptions {
  verifiers: TrustedMcpVerifier[];
  clock?: () => Date;
  maxAttestationAgeMs?: number;
  maxFutureSkewMs?: number;
}

interface PreparedVerifier {
  verifierKey: string;
  keyId: string;
  verifierName: string;
  publicKey: KeyObject;
  scopes: readonly Readonly<McpVerifierScope>[];
  acceptNewAttestations: boolean;
}

const verifiedHealthToken = Symbol("forgex-verified-mcp-health");

export class VerifiedMcpHealthReceipt {
  readonly #authentic = true;
  readonly #validUntilMs: number;
  readonly #maxFutureSkewMs: number;
  readonly payload: Readonly<McpHealthPayload>;
  readonly signature: string;
  readonly verifierName: string;

  constructor(
    payload: McpHealthPayload,
    signature: string,
    verifierName: string,
    validity: { validUntilMs: number; maxFutureSkewMs: number },
    token: typeof verifiedHealthToken,
  ) {
    if (token !== verifiedHealthToken) {
      throw new Error("MCP 探测必须经过受信任的 McpHealthAuthority");
    }
    this.payload = Object.freeze(structuredClone(payload));
    this.signature = signature;
    this.verifierName = verifierName;
    this.#validUntilMs = validity.validUntilMs;
    this.#maxFutureSkewMs = validity.maxFutureSkewMs;
    Object.freeze(this);
  }

  static assertAuthentic(receipt: VerifiedMcpHealthReceipt): void {
    if (!receipt.#authentic) throw new Error("MCP 探测不是可信验证结果");
  }

  static assertUsableAt(receipt: VerifiedMcpHealthReceipt, now: Date): void {
    VerifiedMcpHealthReceipt.assertAuthentic(receipt);
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) throw new Error("MCP 探测校验时间无效");
    const producedAtMs = Date.parse(receipt.payload.producedAt);
    if (producedAtMs > nowMs + receipt.#maxFutureSkewMs) {
      throw new Error("MCP 探测时间超出允许的未来偏差");
    }
    if (nowMs > receipt.#validUntilMs) {
      throw new Error("MCP 探测已经过期，请重新检查连接");
    }
  }

  static isUsableAt(receipt: VerifiedMcpHealthReceipt, now: Date): boolean {
    VerifiedMcpHealthReceipt.assertAuthentic(receipt);
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) throw new Error("MCP 探测校验时间无效");
    const producedAtMs = Date.parse(receipt.payload.producedAt);
    return (
      producedAtMs <= nowMs + receipt.#maxFutureSkewMs &&
      nowMs <= receipt.#validUntilMs
    );
  }
}

const normalizeManifest = (input: McpServerManifest): McpServerManifest => {
  const parsed = McpServerManifestSchema.parse(input);
  return {
    ...parsed,
    tools: [...parsed.tools].sort((left, right) =>
      left.technicalName < right.technicalName
        ? -1
        : left.technicalName > right.technicalName
          ? 1
          : 0,
    ),
  };
};

export class McpHealthAuthority {
  readonly #verifiers = new Map<string, PreparedVerifier>();
  readonly #clock: () => Date;
  readonly #maxAttestationAgeMs: number;
  readonly #maxFutureSkewMs: number;

  constructor(options: McpHealthAuthorityOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#maxAttestationAgeMs =
      options.maxAttestationAgeMs ?? 24 * 60 * 60 * 1_000;
    this.#maxFutureSkewMs = options.maxFutureSkewMs ?? 5 * 60 * 1_000;
    if (
      !Number.isSafeInteger(this.#maxAttestationAgeMs) ||
      !Number.isSafeInteger(this.#maxFutureSkewMs) ||
      this.#maxAttestationAgeMs < 1 ||
      this.#maxFutureSkewMs < 0
    ) {
      throw new Error("MCP 探测有效期配置无效");
    }
    if (options.verifiers.length > 100) {
      throw new Error("受信任 MCP 探测器最多配置 100 个");
    }
    for (const input of options.verifiers) {
      const verifier = McpHealthAuthority.#prepareVerifier(input);
      const key = McpHealthAuthority.#lookupKey(
        verifier.verifierKey,
        verifier.keyId,
      );
      if (this.#verifiers.has(key)) {
        throw new Error("MCP 探测器的 verifierKey 与 keyId 不能重复");
      }
      this.#verifiers.set(key, verifier);
    }
  }

  static canonicalManifest(input: McpServerManifest): string {
    const manifest = normalizeManifest(input);
    return JSON.stringify({
      schemaVersion: manifest.schemaVersion,
      serverKey: manifest.serverKey,
      tenantKey: manifest.tenantKey,
      projectKey: manifest.projectKey,
      revision: manifest.revision,
      name: manifest.name,
      summary: manifest.summary,
      transport: manifest.transport,
      connectionBindingKey: manifest.connectionBindingKey,
      protocolVersion: manifest.protocolVersion,
      tools: manifest.tools.map((tool) => ({
        toolKey: tool.toolKey,
        technicalName: tool.technicalName,
        displayName: tool.displayName,
        description: tool.description,
        effect: tool.effect,
        approval: tool.approval,
        inputSchemaHashAlgorithm: tool.inputSchemaHashAlgorithm,
        inputSchemaHash: tool.inputSchemaHash,
      })),
      publishedAt: manifest.publishedAt,
    });
  }

  static manifestHash(input: McpServerManifest): string {
    return createHash("sha256")
      .update(McpHealthAuthority.canonicalManifest(input), "utf8")
      .digest("hex");
  }

  static canonicalPayload(input: McpHealthPayload): string {
    const payload = McpHealthPayloadSchema.parse(input);
    const observedTools = [...payload.observedTools].sort((left, right) =>
      left.technicalName < right.technicalName
        ? -1
        : left.technicalName > right.technicalName
          ? 1
          : 0,
    );
    return JSON.stringify({
      schemaVersion: payload.schemaVersion,
      attestationKey: payload.attestationKey,
      probeSequence: payload.probeSequence,
      previousAttestationKey: payload.previousAttestationKey,
      tenantKey: payload.tenantKey,
      projectKey: payload.projectKey,
      serverKey: payload.serverKey,
      serverRevision: payload.serverRevision,
      manifestHashAlgorithm: payload.manifestHashAlgorithm,
      manifestHash: payload.manifestHash,
      verifierKey: payload.verifierKey,
      keyId: payload.keyId,
      serverIdentityHashAlgorithm: payload.serverIdentityHashAlgorithm,
      serverIdentityHash: payload.serverIdentityHash,
      protocolVersion: payload.protocolVersion,
      observedTools: observedTools.map((tool) => ({
        technicalName: tool.technicalName,
        inputSchemaHashAlgorithm: tool.inputSchemaHashAlgorithm,
        inputSchemaHash: tool.inputSchemaHash,
      })),
      status: payload.status,
      recoveryChallengeKey: payload.recoveryChallengeKey,
      producedAt: payload.producedAt,
    });
  }

  verify(input: SignedMcpHealthAttestation): VerifiedMcpHealthReceipt {
    return this.#verify(input, true);
  }

  verifyPersisted(input: SignedMcpHealthAttestation): VerifiedMcpHealthReceipt {
    return this.#verify(input, false);
  }

  #verify(
    input: SignedMcpHealthAttestation,
    enforceCurrentFreshness: boolean,
  ): VerifiedMcpHealthReceipt {
    const parsed = SignedMcpHealthAttestationSchema.safeParse(input);
    if (!parsed.success) throw new Error("MCP 探测结果格式无效");
    const verifier = this.#verifiers.get(
      McpHealthAuthority.#lookupKey(
        parsed.data.payload.verifierKey,
        parsed.data.payload.keyId,
      ),
    );
    if (!verifier) throw new Error("MCP 探测器或签名密钥不受信任");
    if (enforceCurrentFreshness && !verifier.acceptNewAttestations) {
      throw new Error("这个 MCP 探测密钥只用于核验历史探测");
    }
    if (
      !verifier.scopes.some(
        (scope) =>
          scope.tenantKey === parsed.data.payload.tenantKey &&
          scope.projectKey === parsed.data.payload.projectKey,
      )
    ) {
      throw new Error("MCP 探测器无权验证这个租户或项目");
    }
    if (enforceCurrentFreshness) {
      this.#assertFresh(parsed.data.payload.producedAt);
    }
    const verified = verifySignature(
      null,
      Buffer.from(
        McpHealthAuthority.canonicalPayload(parsed.data.payload),
        "utf8",
      ),
      verifier.publicKey,
      Buffer.from(parsed.data.signature, "base64"),
    );
    if (!verified) throw new Error("MCP 探测签名无效");
    return new VerifiedMcpHealthReceipt(
      parsed.data.payload,
      parsed.data.signature,
      verifier.verifierName,
      {
        validUntilMs:
          Date.parse(parsed.data.payload.producedAt) +
          this.#maxAttestationAgeMs,
        maxFutureSkewMs: this.#maxFutureSkewMs,
      },
      verifiedHealthToken,
    );
  }

  #assertFresh(producedAt: string): void {
    const producedAtMs = Date.parse(producedAt);
    const nowMs = this.#clock().getTime();
    if (!Number.isFinite(nowMs)) throw new Error("MCP 探测校验时间无效");
    if (producedAtMs > nowMs + this.#maxFutureSkewMs) {
      throw new Error("MCP 探测时间超出允许的未来偏差");
    }
    if (producedAtMs < nowMs - this.#maxAttestationAgeMs) {
      throw new Error("MCP 探测已经过期，请重新检查连接");
    }
  }

  static #lookupKey(verifierKey: string, keyId: string): string {
    return `${verifierKey.toLowerCase()}:${keyId.toLowerCase()}`;
  }

  static #prepareVerifier(input: TrustedMcpVerifier): PreparedVerifier {
    const verifierKey = internalKey.parse(input.verifierKey);
    const keyId = internalKey.parse(input.keyId);
    const verifierName = humanLabel.parse(input.verifierName);
    if (input.scopes.length < 1 || input.scopes.length > 100) {
      throw new Error("MCP 探测器需要 1 到 100 个授权范围");
    }
    if (
      input.acceptNewAttestations !== undefined &&
      typeof input.acceptNewAttestations !== "boolean"
    ) {
      throw new Error("MCP 探测器配置无效");
    }
    const scopes = input.scopes.map((scope) =>
      Object.freeze({
        tenantKey: internalKey.parse(scope.tenantKey),
        projectKey: internalKey.parse(scope.projectKey),
      }),
    );
    if (
      new Set(scopes.map((scope) => `${scope.tenantKey}:${scope.projectKey}`))
        .size !== scopes.length
    ) {
      throw new Error("MCP 探测器授权范围不能重复");
    }
    let publicKey: KeyObject;
    try {
      const bytes = Buffer.from(input.publicKeyBase64, "base64");
      if (bytes.toString("base64") !== input.publicKeyBase64) {
        throw new Error("non-canonical-base64");
      }
      publicKey = createPublicKey({ key: bytes, format: "der", type: "spki" });
    } catch {
      throw new Error("MCP 探测器的 Ed25519 公钥无效");
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("MCP 探测器必须使用 Ed25519 公钥");
    }
    return {
      verifierKey,
      keyId,
      verifierName,
      publicKey,
      scopes: Object.freeze(scopes),
      acceptNewAttestations: input.acceptNewAttestations ?? true,
    };
  }
}

const McpHealthFuseSchema = z
  .object({
    failureAttestationKey: internalKey,
    recoveryChallengeKey: internalKey,
    recoveryAttestationKey: internalKey.nullable(),
  })
  .strict();

type McpHealthFuse = z.infer<typeof McpHealthFuseSchema>;

interface McpRelease {
  manifest: McpServerManifest;
  attestations: Map<
    string,
    {
      signed: SignedMcpHealthAttestation;
      receipt: VerifiedMcpHealthReceipt;
    }
  >;
  healthFuse: McpHealthFuse | null;
  probeHeadAttestationKey: string | null;
}

interface RegisteredMcpServer {
  name: string;
  releases: Map<number, McpRelease>;
  enabledRevision: number | null;
  identityHash: string | null;
  identityAttestationKey: string | null;
}

export const McpEnableRecordSchema = z
  .object({
    action: z.enum(["enabled", "rolled_back", "disabled", "health_disabled"]),
    actorKey: internalKey,
    actorName: humanLabel,
    serverKey: internalKey,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    attestationKey: internalKey,
    recordedAt: z.iso.datetime(),
  })
  .strict();

export type McpEnableRecord = z.infer<typeof McpEnableRecordSchema>;

const McpReleaseSnapshotSchema = z
  .object({
    manifest: McpServerManifestSchema,
    attestations: z.array(SignedMcpHealthAttestationSchema).max(5),
    healthFuse: McpHealthFuseSchema.nullable(),
    probeHeadAttestationKey: internalKey.nullable(),
  })
  .strict();

const McpServerSnapshotItemSchema = z
  .object({
    serverKey: internalKey,
    identityAttestationKey: internalKey.nullable(),
    enabledRevision: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    releases: z.array(McpReleaseSnapshotSchema).min(1).max(20),
  })
  .strict();

export const McpServerRegistrySnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    tenantKey: internalKey,
    projectKey: internalKey,
    servers: z.array(McpServerSnapshotItemSchema).max(100),
    enableRecords: z.array(McpEnableRecordSchema).max(100),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const releaseCount = snapshot.servers.reduce(
      (total, server) => total + server.releases.length,
      0,
    );
    const attestationCount = snapshot.servers.reduce(
      (total, server) =>
        total +
        server.releases.reduce(
          (releaseTotal, release) => releaseTotal + release.attestations.length,
          0,
        ),
      0,
    );
    if (releaseCount > 500) {
      context.addIssue({
        code: "custom",
        path: ["servers"],
        message: "MCP 快照最多保留 500 个版本",
      });
    }
    if (attestationCount > 1_000) {
      context.addIssue({
        code: "custom",
        path: ["servers"],
        message: "MCP 快照最多保留 1000 次探测",
      });
    }
  });

export type McpServerRegistrySnapshot = z.infer<
  typeof McpServerRegistrySnapshotSchema
>;

export interface McpServerRegistryOptions {
  tenantKey: string;
  projectKey: string;
  healthAuthority: McpHealthAuthority;
  clock?: () => Date;
}

export interface McpServerPeopleView {
  name: string;
  summary: string;
  status: "可使用" | "等待验证" | "需要处理";
  detail: string;
  supportingText: string;
}

export interface McpServerRegistryItemForPeople {
  serverKey: string;
  view: McpServerPeopleView;
}

export interface McpHealthRecordOutcome {
  transition: McpEnableRecord | null;
  recoveryChallengeKey: string | null;
  nextProbeSequence: number;
  previousAttestationKey: string | null;
}

export interface McpProbeBinding {
  probeSequence: number;
  previousAttestationKey: string | null;
}

const MAX_SERVERS = 100;
const MAX_RELEASES_PER_SERVER = 20;
const MAX_ATTESTATIONS_PER_RELEASE = 5;
const MAX_TOTAL_RELEASES = 500;
const MAX_TOTAL_ATTESTATIONS = 1_000;
const MAX_ROUTINE_ATTESTATIONS = MAX_TOTAL_ATTESTATIONS - MAX_SERVERS;

const latestHealth = (
  release: McpRelease,
):
  | { signed: SignedMcpHealthAttestation; receipt: VerifiedMcpHealthReceipt }
  | undefined =>
  [...release.attestations.values()].sort((left, right) => {
    const byTime =
      Date.parse(right.receipt.payload.producedAt) -
      Date.parse(left.receipt.payload.producedAt);
    if (byTime !== 0) return byTime;
    if (left.receipt.payload.status !== right.receipt.payload.status) {
      return left.receipt.payload.status === "unhealthy" ? -1 : 1;
    }
    return left.receipt.payload.attestationKey <
      right.receipt.payload.attestationKey
      ? -1
      : left.receipt.payload.attestationKey >
          right.receipt.payload.attestationKey
        ? 1
        : 0;
  })[0];

const compareHealthForEviction = (
  left: { receipt: VerifiedMcpHealthReceipt },
  right: { receipt: VerifiedMcpHealthReceipt },
): number => {
  const byTime =
    Date.parse(left.receipt.payload.producedAt) -
    Date.parse(right.receipt.payload.producedAt);
  if (byTime !== 0) return byTime;
  if (left.receipt.payload.status !== right.receipt.payload.status) {
    return left.receipt.payload.status === "healthy" ? -1 : 1;
  }
  return left.receipt.payload.attestationKey <
    right.receipt.payload.attestationKey
    ? -1
    : left.receipt.payload.attestationKey > right.receipt.payload.attestationKey
      ? 1
      : 0;
};

export class McpServerRegistry {
  readonly #tenantKey: string;
  readonly #projectKey: string;
  readonly #healthAuthority: McpHealthAuthority;
  readonly #clock: () => Date;
  readonly #servers = new Map<string, RegisteredMcpServer>();
  readonly #attestationKeys = new Map<string, string>();
  readonly #currentEnableRecords = new Map<string, McpEnableRecord>();

  constructor(options: McpServerRegistryOptions) {
    this.#tenantKey = internalKey.parse(options.tenantKey);
    this.#projectKey = internalKey.parse(options.projectKey);
    this.#healthAuthority = options.healthAuthority;
    this.#clock = options.clock ?? (() => new Date());
  }

  static fromSnapshot(
    input: McpServerRegistrySnapshot,
    options: McpServerRegistryOptions,
  ): McpServerRegistry {
    const snapshot = McpServerRegistrySnapshotSchema.parse(input);
    const registry = new McpServerRegistry(options);
    registry.#assertScope(snapshot.tenantKey, snapshot.projectKey);
    const serverKeys = new Set<string>();
    const attestationKeys = new Set<string>();
    for (const item of snapshot.servers) {
      if (serverKeys.has(item.serverKey)) {
        throw new Error("MCP 快照不能包含重复服务器");
      }
      serverKeys.add(item.serverKey);
      const revisions = new Set<number>();
      const releases = [...item.releases].sort(
        (left, right) => left.manifest.revision - right.manifest.revision,
      );
      for (const release of releases) {
        if (revisions.has(release.manifest.revision)) {
          throw new Error("MCP 快照不能包含重复版本");
        }
        revisions.add(release.manifest.revision);
        if (release.manifest.serverKey !== item.serverKey) {
          throw new Error("MCP 快照版本不属于对应服务器");
        }
        registry.publish(release.manifest);
        for (const signed of release.attestations) {
          if (attestationKeys.has(signed.payload.attestationKey)) {
            throw new Error("MCP 快照不能包含重复探测");
          }
          attestationKeys.add(signed.payload.attestationKey);
          registry.#recordVerifiedHealth(
            signed,
            options.healthAuthority.verifyPersisted(signed),
            true,
          );
        }
        const restoredRelease = registry.#servers
          .get(item.serverKey)!
          .releases.get(release.manifest.revision)!;
        const probeSequences = new Set<number>();
        let latestProbe:
          | {
              attestationKey: string;
              sequence: number;
            }
          | undefined;
        for (const attestation of restoredRelease.attestations.values()) {
          const sequence = attestation.receipt.payload.probeSequence;
          if (probeSequences.has(sequence)) {
            throw new Error("MCP 快照不能包含重复的探测序号");
          }
          probeSequences.add(sequence);
          if (!latestProbe || sequence > latestProbe.sequence) {
            latestProbe = {
              attestationKey: attestation.receipt.payload.attestationKey,
              sequence,
            };
          }
        }
        if (
          release.probeHeadAttestationKey !==
          (latestProbe?.attestationKey ?? null)
        ) {
          throw new Error("MCP 快照的探测链头与签名探测不一致");
        }
        for (const attestation of restoredRelease.attestations.values()) {
          const previousKey =
            attestation.receipt.payload.previousAttestationKey;
          const previous = previousKey
            ? restoredRelease.attestations.get(previousKey)
            : undefined;
          if (
            previous &&
            previous.receipt.payload.probeSequence + 1 !==
              attestation.receipt.payload.probeSequence
          ) {
            throw new Error("MCP 快照中的签名探测链不连续");
          }
        }
        restoredRelease.probeHeadAttestationKey =
          release.probeHeadAttestationKey;
        const hasFailure = [...restoredRelease.attestations.values()].some(
          (attestation) => attestation.receipt.payload.status === "unhealthy",
        );
        if (!release.healthFuse) {
          if (hasFailure) {
            throw new Error("MCP 失败探测缺少恢复熔断记录");
          }
          continue;
        }
        const failure = restoredRelease.attestations.get(
          release.healthFuse.failureAttestationKey,
        );
        if (failure?.receipt.payload.status !== "unhealthy") {
          throw new Error("MCP 恢复熔断没有绑定失败探测");
        }
        if (release.healthFuse.recoveryAttestationKey) {
          const recovery = restoredRelease.attestations.get(
            release.healthFuse.recoveryAttestationKey,
          );
          if (
            recovery?.receipt.payload.status !== "healthy" ||
            recovery.receipt.payload.recoveryChallengeKey !==
              release.healthFuse.recoveryChallengeKey
          ) {
            throw new Error("MCP 恢复熔断没有绑定后续健康探测");
          }
        }
        restoredRelease.healthFuse = structuredClone(release.healthFuse);
      }
      const restoredServer = registry.#servers.get(item.serverKey)!;
      const identityAttestation = item.identityAttestationKey
        ? [...restoredServer.releases.values()]
            .map((release) =>
              release.attestations.get(item.identityAttestationKey!),
            )
            .find((attestation) => attestation !== undefined)
        : undefined;
      if (item.identityAttestationKey) {
        if (identityAttestation?.receipt.payload.status !== "healthy") {
          throw new Error("MCP 身份锚没有绑定可信健康探测");
        }
        if (
          restoredServer.identityHash !==
          identityAttestation.receipt.payload.serverIdentityHash
        ) {
          throw new Error("MCP 身份锚与历史可信身份不一致");
        }
        restoredServer.identityAttestationKey = item.identityAttestationKey;
      } else if (restoredServer.identityHash) {
        throw new Error("MCP 快照中的可信服务器身份缺少锚定探测");
      }
    }

    const restoredEnabled = new Map<string, number>();
    for (const record of snapshot.enableRecords) {
      if (record.action === "disabled" || record.action === "health_disabled") {
        throw new Error("MCP 当前启用记录不能是停用操作");
      }
      if (restoredEnabled.has(record.serverKey)) {
        throw new Error("MCP 快照不能包含重复的当前启用记录");
      }
      const release = registry.#servers
        .get(record.serverKey)
        ?.releases.get(record.revision);
      const attestation = release?.attestations.get(record.attestationKey);
      if (!release || !attestation) {
        throw new Error("MCP 启用审计没有绑定可信探测和服务器版本");
      }
      if (attestation.receipt.payload.status !== "healthy") {
        throw new Error("MCP 启用审计必须绑定健康探测");
      }
      if (
        release.healthFuse &&
        record.attestationKey !== release.healthFuse.recoveryAttestationKey
      ) {
        throw new Error("MCP 启用审计没有绑定熔断后的恢复探测");
      }
      restoredEnabled.set(record.serverKey, record.revision);
      registry.#currentEnableRecords.set(
        record.serverKey,
        structuredClone(record),
      );
    }

    for (const item of snapshot.servers) {
      const restoredRevision = restoredEnabled.get(item.serverKey) ?? null;
      if (item.enabledRevision !== restoredRevision) {
        throw new Error("MCP 快照的启用版本与审计不一致");
      }
      registry.#servers.get(item.serverKey)!.enabledRevision = restoredRevision;
    }
    return registry;
  }

  publish(input: McpServerManifest): void {
    const manifest = normalizeManifest(input);
    this.#assertScope(manifest.tenantKey, manifest.projectKey);
    let server = this.#servers.get(manifest.serverKey);
    const isNewServer = !server;
    if (!server) {
      if (this.#servers.size >= MAX_SERVERS) {
        throw new Error("同一项目最多管理 100 个 MCP 服务器");
      }
      if (
        [...this.#servers.values()].some(
          (candidate) =>
            candidate.name.toLowerCase() === manifest.name.toLowerCase(),
        )
      ) {
        throw new Error("MCP 服务器业务名称不能重复");
      }
      if (manifest.revision !== 1) {
        throw new Error("MCP 服务器必须从第一个版本开始发布");
      }
      server = {
        name: manifest.name,
        releases: new Map(),
        enabledRevision: null,
        identityHash: null,
        identityAttestationKey: null,
      };
    } else if (server.name !== manifest.name) {
      throw new Error("同一 MCP 服务器不能更改业务名称");
    }

    const existing = server.releases.get(manifest.revision);
    if (existing) {
      if (
        McpHealthAuthority.canonicalManifest(existing.manifest) ===
        McpHealthAuthority.canonicalManifest(manifest)
      ) {
        return;
      }
      throw new Error("同一版本的 MCP 服务器清单不能被覆盖");
    }
    if (server.releases.size >= MAX_RELEASES_PER_SERVER) {
      throw new Error("同一 MCP 服务器最多保留 20 个版本");
    }
    const totalReleases = [...this.#servers.values()].reduce(
      (total, candidate) => total + candidate.releases.size,
      0,
    );
    if (totalReleases >= MAX_TOTAL_RELEASES) {
      throw new Error("同一项目最多保留 500 个 MCP 服务器版本");
    }
    const latestRevision = Math.max(0, ...server.releases.keys());
    if (manifest.revision !== latestRevision + 1) {
      throw new Error("MCP 服务器版本必须连续发布");
    }
    server.releases.set(manifest.revision, {
      manifest: structuredClone(manifest),
      attestations: new Map(),
      healthFuse: null,
      probeHeadAttestationKey: null,
    });
    if (isNewServer) this.#servers.set(manifest.serverKey, server);
  }

  recordHealth(input: SignedMcpHealthAttestation): McpHealthRecordOutcome {
    const receipt = this.#healthAuthority.verify(input);
    const transition = this.#recordVerifiedHealth(
      {
        payload: structuredClone(receipt.payload),
        signature: receipt.signature,
      },
      receipt,
    );
    const nextProbe = this.getNextProbeBinding(
      receipt.payload.serverKey,
      receipt.payload.serverRevision,
    );
    return {
      transition: transition ? structuredClone(transition) : null,
      recoveryChallengeKey: this.getRecoveryChallenge(
        receipt.payload.serverKey,
        receipt.payload.serverRevision,
      ),
      nextProbeSequence: nextProbe.probeSequence,
      previousAttestationKey: nextProbe.previousAttestationKey,
    };
  }

  #recordVerifiedHealth(
    input: SignedMcpHealthAttestation,
    receipt: VerifiedMcpHealthReceipt,
    restoring = false,
  ): McpEnableRecord | null {
    VerifiedMcpHealthReceipt.assertAuthentic(receipt);
    const payload = receipt.payload;
    this.#assertScope(payload.tenantKey, payload.projectKey);
    const server = this.#servers.get(payload.serverKey);
    const release = server?.releases.get(payload.serverRevision);
    if (!server || !release) {
      throw new Error("找不到 MCP 探测对应的服务器版本");
    }
    if (
      payload.manifestHash !== McpHealthAuthority.manifestHash(release.manifest)
    ) {
      throw new Error("MCP 探测没有绑定当前服务器清单");
    }
    const expectedTools = release.manifest.tools
      .map(
        (tool) =>
          `${tool.technicalName}:${tool.inputSchemaHashAlgorithm}:${tool.inputSchemaHash}`,
      )
      .sort();
    const observedTools = payload.observedTools
      .map(
        (tool) =>
          `${tool.technicalName}:${tool.inputSchemaHashAlgorithm}:${tool.inputSchemaHash}`,
      )
      .sort();
    if (payload.status === "healthy") {
      if (payload.protocolVersion !== release.manifest.protocolVersion) {
        throw new Error("MCP 服务器协议版本与发布清单不一致");
      }
      if (JSON.stringify(expectedTools) !== JSON.stringify(observedTools)) {
        throw new Error("MCP 服务器实际能力与发布清单不一致");
      }
      if (
        server.identityHash &&
        server.identityHash !== payload.serverIdentityHash
      ) {
        throw new Error("MCP 服务器身份与历史可信身份不一致");
      }
    }
    const canonicalSigned = JSON.stringify(
      SignedMcpHealthAttestationSchema.parse(input),
    );
    const known = this.#attestationKeys.get(payload.attestationKey);
    if (known) {
      if (known === canonicalSigned) return null;
      throw new Error("同一 MCP 探测标识不能绑定不同内容");
    }
    if (!restoring) {
      const head = release.probeHeadAttestationKey
        ? release.attestations.get(release.probeHeadAttestationKey)
        : undefined;
      const expectedSequence = head
        ? head.receipt.payload.probeSequence + 1
        : 1;
      if (
        payload.probeSequence !== expectedSequence ||
        payload.previousAttestationKey !==
          (head?.receipt.payload.attestationKey ?? null)
      ) {
        throw new Error("MCP 探测没有接续当前可信探测链");
      }
    }
    const isActiveFailure =
      payload.status === "unhealthy" &&
      server.enabledRevision === payload.serverRevision;
    if (
      !restoring &&
      release.attestations.size >= MAX_ATTESTATIONS_PER_RELEASE
    ) {
      const activeAttestationKey = this.#currentEnableRecords.get(
        payload.serverKey,
      )?.attestationKey;
      const currentDecisionKey =
        latestHealth(release)?.receipt.payload.attestationKey;
      const removable = [...release.attestations.values()]
        .filter(
          (candidate) =>
            candidate.receipt.payload.attestationKey !==
              server.identityAttestationKey &&
            (payload.status === "unhealthy" ||
              (candidate.receipt.payload.attestationKey !==
                activeAttestationKey &&
                candidate.receipt.payload.attestationKey !==
                  currentDecisionKey &&
                candidate.receipt.payload.attestationKey !==
                  release.probeHeadAttestationKey &&
                candidate.receipt.payload.attestationKey !==
                  release.healthFuse?.failureAttestationKey &&
                candidate.receipt.payload.attestationKey !==
                  release.healthFuse?.recoveryAttestationKey)),
        )
        .sort(compareHealthForEviction)[0];
      if (!removable) {
        throw new Error("MCP 探测保留窗口没有可替换的历史记录");
      }
      release.attestations.delete(removable.receipt.payload.attestationKey);
      this.#attestationKeys.delete(removable.receipt.payload.attestationKey);
    }
    let totalAttestations = [...this.#servers.values()].reduce(
      (serverTotal, candidate) =>
        serverTotal +
        [...candidate.releases.values()].reduce(
          (releaseTotal, item) => releaseTotal + item.attestations.size,
          0,
        ),
      0,
    );
    const totalLimit = isActiveFailure
      ? MAX_TOTAL_ATTESTATIONS
      : MAX_ROUTINE_ATTESTATIONS;
    if (!restoring && totalAttestations >= totalLimit) {
      const replaceableFailureHistory =
        payload.status === "unhealthy"
          ? [...release.attestations.values()]
              .filter(
                (candidate) =>
                  candidate.receipt.payload.attestationKey !==
                  server.identityAttestationKey,
              )
              .sort(compareHealthForEviction)[0]
          : undefined;
      if (replaceableFailureHistory) {
        const replacedKey =
          replaceableFailureHistory.receipt.payload.attestationKey;
        release.attestations.delete(replacedKey);
        this.#attestationKeys.delete(replacedKey);
        totalAttestations -= 1;
      }
      if (
        totalAttestations >= totalLimit &&
        !this.#evictOldestUnreferencedHealth()
      ) {
        throw new Error("同一项目最多保留 1000 次 MCP 探测");
      }
    }
    if (payload.status === "healthy") {
      server.identityHash = payload.serverIdentityHash;
      if (!restoring && !server.identityAttestationKey) {
        server.identityAttestationKey = payload.attestationKey;
      }
    }
    this.#attestationKeys.set(payload.attestationKey, canonicalSigned);
    release.attestations.set(payload.attestationKey, {
      signed: {
        payload: structuredClone(receipt.payload),
        signature: receipt.signature,
      },
      receipt,
    });
    if (restoring) return null;
    release.probeHeadAttestationKey = payload.attestationKey;
    if (payload.status === "healthy") {
      if (
        release.healthFuse &&
        payload.recoveryChallengeKey === release.healthFuse.recoveryChallengeKey
      ) {
        release.healthFuse.recoveryAttestationKey = payload.attestationKey;
      }
      return null;
    }
    release.healthFuse = {
      failureAttestationKey: payload.attestationKey,
      recoveryChallengeKey: randomUUID(),
      recoveryAttestationKey: null,
    };
    if (server.enabledRevision === payload.serverRevision) {
      const recordedAt = this.#clock();
      if (!Number.isFinite(recordedAt.getTime())) {
        throw new Error("MCP 自动停用时间无效");
      }
      const transition: McpEnableRecord = {
        action: "health_disabled",
        actorKey: payload.verifierKey,
        actorName: receipt.verifierName,
        serverKey: payload.serverKey,
        revision: payload.serverRevision,
        attestationKey: payload.attestationKey,
        recordedAt: recordedAt.toISOString(),
      };
      server.enabledRevision = null;
      this.#currentEnableRecords.delete(payload.serverKey);
      return transition;
    }
    return null;
  }

  enable(command: {
    serverKey: string;
    revision: number;
    actor: { actorKey: string; actorName: string };
  }): McpEnableRecord | null {
    const serverKey = internalKey.parse(command.serverKey);
    const revision = z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .parse(command.revision);
    const actor = z
      .object({ actorKey: internalKey, actorName: humanLabel })
      .strict()
      .parse(command.actor);
    const server = this.#servers.get(serverKey);
    const release = server?.releases.get(revision);
    if (!server || !release) throw new Error("找不到要启用的 MCP 服务器版本");
    if (server.enabledRevision === revision) return null;
    const attestation = release.healthFuse
      ? release.healthFuse.recoveryAttestationKey
        ? release.attestations.get(release.healthFuse.recoveryAttestationKey)
        : undefined
      : latestHealth(release);
    if (release.healthFuse && !attestation) {
      throw new Error("MCP 熔断后需要携带恢复挑战的新健康探测");
    }
    if (!attestation) throw new Error("MCP 服务器尚未通过可信探测");
    if (attestation.receipt.payload.status !== "healthy") {
      throw new Error("最近一次 MCP 探测未通过");
    }
    const current = this.#clock();
    VerifiedMcpHealthReceipt.assertUsableAt(attestation.receipt, current);
    const previousRevision = server.enabledRevision;
    const record: McpEnableRecord = {
      action:
        previousRevision !== null && revision < previousRevision
          ? "rolled_back"
          : "enabled",
      actorKey: actor.actorKey,
      actorName: actor.actorName,
      serverKey,
      revision,
      attestationKey: attestation.receipt.payload.attestationKey,
      recordedAt: current.toISOString(),
    };
    server.enabledRevision = revision;
    this.#currentEnableRecords.set(serverKey, record);
    return structuredClone(record);
  }

  getRecoveryChallenge(
    serverKeyInput: string,
    revisionInput: number,
  ): string | null {
    const serverKey = internalKey.parse(serverKeyInput);
    const revision = z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .parse(revisionInput);
    return (
      this.#servers.get(serverKey)?.releases.get(revision)?.healthFuse
        ?.recoveryChallengeKey ?? null
    );
  }

  getNextProbeBinding(
    serverKeyInput: string,
    revisionInput: number,
  ): McpProbeBinding {
    const serverKey = internalKey.parse(serverKeyInput);
    const revision = z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .parse(revisionInput);
    const release = this.#servers.get(serverKey)?.releases.get(revision);
    if (!release) throw new Error("找不到要探测的 MCP 服务器版本");
    const head = release.probeHeadAttestationKey
      ? release.attestations.get(release.probeHeadAttestationKey)
      : undefined;
    if (head?.receipt.payload.probeSequence === Number.MAX_SAFE_INTEGER) {
      throw new Error("MCP 探测序号已经达到安全上限");
    }
    return {
      probeSequence: (head?.receipt.payload.probeSequence ?? 0) + 1,
      previousAttestationKey: head?.receipt.payload.attestationKey ?? null,
    };
  }

  disable(command: {
    serverKey: string;
    actor: { actorKey: string; actorName: string };
  }): McpEnableRecord | null {
    const serverKey = internalKey.parse(command.serverKey);
    const actor = z
      .object({ actorKey: internalKey, actorName: humanLabel })
      .strict()
      .parse(command.actor);
    const server = this.#servers.get(serverKey);
    if (!server?.enabledRevision) return null;
    const current = this.#currentEnableRecords.get(serverKey);
    if (!current) throw new Error("MCP 启用状态缺少可信探测");
    const now = this.#clock();
    if (!Number.isFinite(now.getTime())) throw new Error("MCP 停用时间无效");
    const record: McpEnableRecord = {
      action: "disabled",
      actorKey: actor.actorKey,
      actorName: actor.actorName,
      serverKey,
      revision: server.enabledRevision,
      attestationKey: current.attestationKey,
      recordedAt: now.toISOString(),
    };
    server.enabledRevision = null;
    this.#currentEnableRecords.delete(serverKey);
    return structuredClone(record);
  }

  getEnabledTool(
    serverKeyInput: string,
    toolKeyInput: string,
  ): { manifest: McpServerManifest; tool: McpToolDefinition } | null {
    const toolKey = internalKey.parse(toolKeyInput);
    const manifest = this.getEnabledManifest(serverKeyInput);
    if (!manifest) return null;
    const tool = manifest.tools.find(
      (candidate) => candidate.toolKey === toolKey,
    );
    return tool ? { manifest, tool: structuredClone(tool) } : null;
  }

  getEnabledManifest(serverKeyInput: string): McpServerManifest | null {
    const serverKey = internalKey.parse(serverKeyInput);
    const server = this.#servers.get(serverKey);
    if (!server?.enabledRevision) return null;
    const release = server.releases.get(server.enabledRevision)!;
    const record = this.#currentEnableRecords.get(serverKey);
    if (!record || !release.attestations.has(record.attestationKey)) {
      throw new Error("MCP 启用状态缺少可信探测");
    }
    const attestation = latestHealth(release);
    if (
      !attestation ||
      attestation.receipt.payload.status !== "healthy" ||
      !VerifiedMcpHealthReceipt.isUsableAt(attestation.receipt, this.#clock())
    ) {
      return null;
    }
    return structuredClone(release.manifest);
  }

  listForPeople(): McpServerPeopleView[] {
    return this.listItemsForPeople().map((item) => item.view);
  }

  listItemsForPeople(): McpServerRegistryItemForPeople[] {
    return [...this.#servers.entries()]
      .map(([serverKey, server]) => {
        const latest = [...server.releases.values()].sort(
          (left, right) => right.manifest.revision - left.manifest.revision,
        )[0]!;
        const enabled = server.enabledRevision
          ? server.releases.get(server.enabledRevision)
          : undefined;
        const record = this.#currentEnableRecords.get(serverKey);
        const health = enabled && record ? latestHealth(enabled) : undefined;
        const receipt = health?.receipt;
        let usable = false;
        if (receipt?.payload.status === "healthy") {
          try {
            VerifiedMcpHealthReceipt.assertUsableAt(receipt, this.#clock());
            usable = true;
          } catch {
            usable = false;
          }
        }
        const displayed = usable && enabled ? enabled : latest;
        const hasHealth = displayed.attestations.size > 0;
        const allReadAutomatic = displayed.manifest.tools.every(
          (tool) => tool.effect === "read" && tool.approval === "automatic",
        );
        return {
          serverKey,
          view: {
            name: displayed.manifest.name,
            summary: displayed.manifest.summary,
            status: usable
              ? ("可使用" as const)
              : hasHealth
                ? ("需要处理" as const)
                : ("等待验证" as const),
            detail: `${displayed.manifest.tools.length} 项业务能力`,
            supportingText: allReadAutomatic
              ? "读取可自动运行"
              : "读取可自动运行，变更前需要确认",
          },
        };
      })
      .sort((left, right) =>
        left.view.name < right.view.name
          ? -1
          : left.view.name > right.view.name
            ? 1
            : 0,
      );
  }

  listEnableRecords(): McpEnableRecord[] {
    return [...this.#currentEnableRecords.values()]
      .sort((left, right) =>
        left.serverKey < right.serverKey
          ? -1
          : left.serverKey > right.serverKey
            ? 1
            : 0,
      )
      .map((record) => structuredClone(record));
  }

  snapshot(): McpServerRegistrySnapshot {
    return {
      schemaVersion: 1,
      tenantKey: this.#tenantKey,
      projectKey: this.#projectKey,
      servers: [...this.#servers.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([serverKey, server]) => ({
          serverKey,
          identityAttestationKey: server.identityAttestationKey,
          enabledRevision: server.enabledRevision,
          releases: [...server.releases.values()]
            .sort(
              (left, right) => left.manifest.revision - right.manifest.revision,
            )
            .map((release) => ({
              manifest: structuredClone(release.manifest),
              attestations: [...release.attestations.values()]
                .sort((left, right) =>
                  left.receipt.payload.attestationKey <
                  right.receipt.payload.attestationKey
                    ? -1
                    : 1,
                )
                .map(({ signed }) => structuredClone(signed)),
              healthFuse: release.healthFuse
                ? structuredClone(release.healthFuse)
                : null,
              probeHeadAttestationKey: release.probeHeadAttestationKey,
            })),
        })),
      enableRecords: this.listEnableRecords(),
    };
  }

  #assertScope(tenantKey: string, projectKey: string): void {
    if (tenantKey !== this.#tenantKey || projectKey !== this.#projectKey) {
      throw new Error("MCP 服务器不属于当前租户或项目");
    }
  }

  #evictOldestUnreferencedHealth(): boolean {
    let oldest:
      | {
          release: McpRelease;
          candidate: {
            signed: SignedMcpHealthAttestation;
            receipt: VerifiedMcpHealthReceipt;
          };
        }
      | undefined;
    for (const [serverKey, server] of this.#servers) {
      const activeAttestationKey =
        this.#currentEnableRecords.get(serverKey)?.attestationKey;
      const activeRelease = server.enabledRevision
        ? server.releases.get(server.enabledRevision)
        : undefined;
      const currentDecisionKey = activeRelease
        ? latestHealth(activeRelease)?.receipt.payload.attestationKey
        : undefined;
      const retainedForServer = [...server.releases.values()].reduce(
        (total, release) => total + release.attestations.size,
        0,
      );
      if (retainedForServer <= 1) continue;
      for (const release of server.releases.values()) {
        for (const candidate of release.attestations.values()) {
          const attestationKey = candidate.receipt.payload.attestationKey;
          if (
            attestationKey === activeAttestationKey ||
            attestationKey === currentDecisionKey ||
            attestationKey === release.probeHeadAttestationKey ||
            attestationKey === server.identityAttestationKey ||
            attestationKey === release.healthFuse?.failureAttestationKey ||
            attestationKey === release.healthFuse?.recoveryAttestationKey
          ) {
            continue;
          }
          if (
            !oldest ||
            compareHealthForEviction(candidate, oldest.candidate) < 0
          ) {
            oldest = { release, candidate };
          }
        }
      }
    }
    if (!oldest) return false;
    const attestationKey = oldest.candidate.receipt.payload.attestationKey;
    oldest.release.attestations.delete(attestationKey);
    this.#attestationKeys.delete(attestationKey);
    return true;
  }
}
