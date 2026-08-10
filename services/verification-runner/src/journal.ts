import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  SignedEvidenceSchema,
  type EvidenceCheck,
  type SignedEvidence,
} from "@forgex/contracts";
import { z } from "zod";

import {
  VerificationRunnerScopeSchema,
  VerificationRunnerTargetSchema,
  type VerificationRunnerScope,
  type VerificationRunnerTarget,
} from "./model.js";
import { VerificationRunnerInstanceLock } from "./instance-lock.js";
import { assertDefaultWindowsPrivatePath } from "./windows-path-security.js";

const artifactEntryBase = {
  schemaVersion: z.literal(1),
  scope: VerificationRunnerScopeSchema,
  target: VerificationRunnerTargetSchema,
  evidenceKey: z.string().uuid(),
  artifactHashAlgorithm: z.literal("sha256"),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/u),
  artifactContentBase64: z.string().min(1).max(7_000_000),
  verificationCompletedAt: z.iso.datetime(),
  checks: z.array(
    z
      .object({
        criterionKey: z.string().uuid(),
        status: z.enum(["passed", "failed"]),
        testRunKey: z.string().trim().min(1).max(200),
      })
      .strict(),
  ),
  integrityTag: z.string().regex(/^[a-f0-9]{64}$/u),
} as const;

export const VerificationArtifactJournalEntrySchema = z
  .object({
    ...artifactEntryBase,
    stage: z.literal("artifact_ready"),
  })
  .strict();

export const VerificationSignedJournalEntrySchema = z
  .object({
    ...artifactEntryBase,
    stage: z.literal("evidence_signed"),
    signedEvidence: SignedEvidenceSchema,
  })
  .strict();

export const VerificationFailureJournalEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    stage: z.literal("verification_failed"),
    scope: VerificationRunnerScopeSchema,
    target: VerificationRunnerTargetSchema,
    verificationCompletedAt: z.iso.datetime(),
    checks: z.array(
      z
        .object({
          criterionKey: z.string().uuid(),
          status: z.enum(["passed", "failed"]),
          testRunKey: z.string().trim().min(1).max(200),
        })
        .strict(),
    ),
    integrityTag: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const VerificationJournalEntrySchema = z.discriminatedUnion("stage", [
  VerificationArtifactJournalEntrySchema,
  VerificationSignedJournalEntrySchema,
  VerificationFailureJournalEntrySchema,
]);

export type VerificationArtifactJournalEntry = z.infer<
  typeof VerificationArtifactJournalEntrySchema
>;
export type VerificationSignedJournalEntry = z.infer<
  typeof VerificationSignedJournalEntrySchema
>;
export type VerificationFailureJournalEntry = z.infer<
  typeof VerificationFailureJournalEntrySchema
>;
export type VerificationJournalEntry = z.infer<
  typeof VerificationJournalEntrySchema
>;

export interface VerificationJournal {
  load(): Promise<VerificationJournalEntry | null>;
  saveArtifact(entry: VerificationArtifactJournalEntry): Promise<void>;
  saveFailure(entry: VerificationFailureJournalEntry): Promise<void>;
  saveSigned(
    entry: VerificationSignedJournalEntry,
    expectedIntegrityTag: string,
  ): Promise<void>;
  clear(expectedIntegrityTag: string): Promise<void>;
}

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const integrityKey = (input: Uint8Array): Buffer => {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength < 32 ||
    input.byteLength > 128
  ) {
    throw new Error("Runner 日志完整性密钥必须包含 32 至 128 字节");
  }
  return Buffer.from(input);
};

const unsignedJournalProjection = (
  entry: VerificationJournalEntry,
): unknown => {
  const { integrityTag: _integrityTag, ...projection } = entry;
  return projection;
};

const journalIntegrityTag = (
  entry: VerificationJournalEntry,
  keyInput: Uint8Array,
): string =>
  createHmac("sha256", integrityKey(keyInput))
    .update(JSON.stringify(unsignedJournalProjection(entry)), "utf8")
    .digest("hex");

export const assertVerificationJournalIntegrity = (
  entryInput: VerificationJournalEntry,
  keyInput: Uint8Array,
): void => {
  const entry = VerificationJournalEntrySchema.parse(entryInput);
  const expected = Buffer.from(journalIntegrityTag(entry, keyInput), "hex");
  const actual = Buffer.from(entry.integrityTag, "hex");
  if (
    actual.byteLength !== expected.byteLength ||
    !timingSafeEqual(actual, expected)
  ) {
    throw new Error("Runner 恢复日志完整性校验失败");
  }
};

const artifactProjection = (
  entry: VerificationSignedJournalEntry,
): VerificationArtifactJournalEntry => {
  const { signedEvidence: _signedEvidence, ...base } = entry;
  return VerificationArtifactJournalEntrySchema.parse({
    ...base,
    stage: "artifact_ready",
  });
};

export class InMemoryVerificationJournal implements VerificationJournal {
  #entry: VerificationJournalEntry | null = null;

  async load(): Promise<VerificationJournalEntry | null> {
    return this.#entry
      ? VerificationJournalEntrySchema.parse(structuredClone(this.#entry))
      : null;
  }

  async saveArtifact(entryInput: VerificationArtifactJournalEntry) {
    const entry = VerificationArtifactJournalEntrySchema.parse(entryInput);
    if (this.#entry && !same(this.#entry, entry)) {
      throw new Error("Runner 已有另一项待恢复验证，不能覆盖持久日志");
    }
    this.#entry = structuredClone(entry);
  }

  async saveFailure(entryInput: VerificationFailureJournalEntry) {
    const entry = VerificationFailureJournalEntrySchema.parse(entryInput);
    if (this.#entry && !same(this.#entry, entry)) {
      throw new Error("Runner 已有另一项待恢复验证，不能覆盖持久日志");
    }
    this.#entry = structuredClone(entry);
  }

  async saveSigned(
    entryInput: VerificationSignedJournalEntry,
    expectedIntegrityTag: string,
  ) {
    const entry = VerificationSignedJournalEntrySchema.parse(entryInput);
    if (!this.#entry) {
      throw new Error("Runner 不能在没有 Preview 制品日志时保存签名证据");
    }
    if (this.#entry.integrityTag !== expectedIntegrityTag) {
      throw new Error("Runner 验证日志已经变化，不能覆盖新的恢复状态");
    }
    if (
      !same(this.#entry, entry) &&
      (this.#entry.stage !== "artifact_ready" ||
        !same(
          unsignedJournalProjection(this.#entry),
          unsignedJournalProjection(artifactProjection(entry)),
        ))
    ) {
      throw new Error("已签名证据与待提交 Preview 制品不一致");
    }
    this.#entry = structuredClone(entry);
  }

  async clear(expectedIntegrityTag: string): Promise<void> {
    if (this.#entry && this.#entry.integrityTag !== expectedIntegrityTag) {
      throw new Error("Runner 验证日志已经变化，不能清理新的恢复状态");
    }
    this.#entry = null;
  }
}

const missingFile = (error: unknown): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";

const samePath = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase()
    : path.normalize(left) === path.normalize(right);

const syncParentDirectory = async (target: string): Promise<void> => {
  if (process.platform === "win32") return;
  const directory = await open(path.dirname(target), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};

const assertPrivateJournalParent = async (
  filePath: string,
  windowsPathCheck: (target: string) => Promise<void>,
): Promise<void> => {
  const parent = path.dirname(filePath);
  const metadata = await lstat(parent);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !samePath(await realpath(parent), parent)
  ) {
    throw new Error("Runner 验证日志父目录必须是不跳转的本地目录");
  }
  if (process.platform === "win32") {
    await windowsPathCheck(parent);
    return;
  }
  if (
    (Number(metadata.mode) & 0o077) !== 0 ||
    (typeof process.getuid === "function" &&
      typeof metadata.uid === "number" &&
      metadata.uid !== process.getuid())
  ) {
    throw new Error("Runner 验证日志父目录必须仅允许当前控制器身份访问");
  }
};

export class FileVerificationJournal implements VerificationJournal {
  readonly #filePath: string;
  readonly #assertWindowsPrivatePath: (target: string) => Promise<void>;
  readonly #instanceLock: VerificationRunnerInstanceLock;
  #closed = false;

  private constructor(
    filePath: string,
    instanceLock: VerificationRunnerInstanceLock,
    options: {
      assertWindowsPrivatePath?: (target: string) => Promise<void>;
    } = {},
  ) {
    if (!path.isAbsolute(filePath)) {
      throw new Error("Runner 验证日志必须使用绝对路径");
    }
    this.#filePath = path.resolve(filePath);
    this.#instanceLock = instanceLock;
    this.#assertWindowsPrivatePath =
      options.assertWindowsPrivatePath ?? assertDefaultWindowsPrivatePath;
  }

  static async open(
    filePath: string,
    options: {
      assertWindowsPrivatePath?: (target: string) => Promise<void>;
    } = {},
  ): Promise<FileVerificationJournal> {
    if (!path.isAbsolute(filePath)) {
      throw new Error("Runner 验证日志必须使用绝对路径");
    }
    const resolved = path.resolve(filePath);
    const identity =
      process.platform === "win32" ? resolved.toLowerCase() : resolved;
    const windowsPathCheck =
      options.assertWindowsPrivatePath ?? assertDefaultWindowsPrivatePath;
    await assertPrivateJournalParent(resolved, windowsPathCheck);
    const instanceLock = await VerificationRunnerInstanceLock.acquire(
      identity,
      path.dirname(resolved),
    );
    try {
      const journal = new FileVerificationJournal(
        resolved,
        instanceLock,
        options,
      );
      await journal.#assertPrivateParent();
      return journal;
    } catch (error) {
      await instanceLock.release();
      throw error;
    }
  }

  async load(): Promise<VerificationJournalEntry | null> {
    this.#assertOpen();
    await this.#assertPrivateParent();
    let handle;
    try {
      handle = await open(
        this.#filePath,
        process.platform === "win32"
          ? constants.O_RDONLY
          : constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.size < 1 ||
        metadata.size > 8 * 1024 * 1024
      ) {
        throw new Error("Runner 验证日志不是可信的普通小文件");
      }
      if (
        process.platform !== "win32" &&
        ((Number(metadata.mode) & 0o077) !== 0 ||
          (typeof process.getuid === "function" &&
            typeof metadata.uid === "number" &&
            metadata.uid !== process.getuid()))
      ) {
        throw new Error("Runner 验证日志必须仅允许当前控制器身份读取");
      }
      if (process.platform === "win32") {
        await this.#assertWindowsPrivatePath(this.#filePath);
      }
      return VerificationJournalEntrySchema.parse(
        JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown,
      );
    } catch (error) {
      if (missingFile(error)) return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async saveArtifact(entryInput: VerificationArtifactJournalEntry) {
    this.#assertOpen();
    const entry = VerificationArtifactJournalEntrySchema.parse(entryInput);
    const existing = await this.load();
    if (existing && !same(existing, entry)) {
      throw new Error("Runner 已有另一项待恢复验证，不能覆盖持久日志");
    }
    if (!existing) await this.#replace(entry);
  }

  async saveFailure(entryInput: VerificationFailureJournalEntry) {
    this.#assertOpen();
    const entry = VerificationFailureJournalEntrySchema.parse(entryInput);
    const existing = await this.load();
    if (existing && !same(existing, entry)) {
      throw new Error("Runner 已有另一项待恢复验证，不能覆盖持久日志");
    }
    if (!existing) await this.#replace(entry);
  }

  async saveSigned(
    entryInput: VerificationSignedJournalEntry,
    expectedIntegrityTag: string,
  ) {
    this.#assertOpen();
    const entry = VerificationSignedJournalEntrySchema.parse(entryInput);
    const existing = await this.load();
    if (!existing) {
      throw new Error("Runner 不能在没有 Preview 制品日志时保存签名证据");
    }
    if (existing.integrityTag !== expectedIntegrityTag) {
      throw new Error("Runner 验证日志已经变化，不能覆盖新的恢复状态");
    }
    if (
      !same(existing, entry) &&
      (existing.stage !== "artifact_ready" ||
        !same(
          unsignedJournalProjection(existing),
          unsignedJournalProjection(artifactProjection(entry)),
        ))
    ) {
      throw new Error("已签名证据与待提交 Preview 制品不一致");
    }
    if (!same(existing, entry)) await this.#replace(entry);
  }

  async clear(expectedIntegrityTag: string): Promise<void> {
    this.#assertOpen();
    const existing = await this.load();
    if (existing && existing.integrityTag !== expectedIntegrityTag) {
      throw new Error("Runner 验证日志已经变化，不能清理新的恢复状态");
    }
    try {
      await unlink(this.#filePath);
      await syncParentDirectory(this.#filePath);
    } catch (error) {
      if (!missingFile(error)) throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#instanceLock.release();
    this.#closed = true;
  }

  async #replace(entry: VerificationJournalEntry): Promise<void> {
    await this.#assertPrivateParent();
    const temporaryPath = `${this.#filePath}.tmp-${process.pid}-${randomUUID()}`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(entry), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, this.#filePath);
      await syncParentDirectory(this.#filePath);
    } catch (error) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (!missingFile(cleanupError)) throw cleanupError;
      }
      throw error;
    }
  }

  async #assertPrivateParent(): Promise<void> {
    await assertPrivateJournalParent(
      this.#filePath,
      this.#assertWindowsPrivatePath,
    );
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Runner 验证日志已经关闭");
    this.#instanceLock.assertHeld();
  }
}

export const verificationArtifactEntry = (input: {
  scope: VerificationRunnerScope;
  target: VerificationRunnerTarget;
  evidenceKey: string;
  artifact: Uint8Array;
  artifactHash: string;
  checks: EvidenceCheck[];
  verificationCompletedAt: string;
  integrityKey: Uint8Array;
}): VerificationArtifactJournalEntry => {
  const unsigned = VerificationArtifactJournalEntrySchema.parse({
    schemaVersion: 1,
    stage: "artifact_ready",
    scope: input.scope,
    target: input.target,
    evidenceKey: input.evidenceKey,
    artifactHashAlgorithm: "sha256",
    artifactHash: input.artifactHash,
    artifactContentBase64: Buffer.from(input.artifact).toString("base64"),
    verificationCompletedAt: input.verificationCompletedAt,
    checks: input.checks,
    integrityTag: "0".repeat(64),
  });
  return VerificationArtifactJournalEntrySchema.parse({
    ...unsigned,
    integrityTag: journalIntegrityTag(unsigned, input.integrityKey),
  });
};

export const verificationFailureEntry = (input: {
  scope: VerificationRunnerScope;
  target: VerificationRunnerTarget;
  checks: EvidenceCheck[];
  verificationCompletedAt: string;
  integrityKey: Uint8Array;
}): VerificationFailureJournalEntry => {
  const unsigned = VerificationFailureJournalEntrySchema.parse({
    schemaVersion: 1,
    stage: "verification_failed",
    scope: input.scope,
    target: input.target,
    verificationCompletedAt: input.verificationCompletedAt,
    checks: input.checks,
    integrityTag: "0".repeat(64),
  });
  return VerificationFailureJournalEntrySchema.parse({
    ...unsigned,
    integrityTag: journalIntegrityTag(unsigned, input.integrityKey),
  });
};

export const verificationSignedEntry = (input: {
  artifactEntry: VerificationArtifactJournalEntry;
  signedEvidence: SignedEvidence;
  integrityKey: Uint8Array;
}): VerificationSignedJournalEntry => {
  const unsigned = VerificationSignedJournalEntrySchema.parse({
    ...input.artifactEntry,
    stage: "evidence_signed",
    signedEvidence: input.signedEvidence,
    integrityTag: "0".repeat(64),
  });
  return VerificationSignedJournalEntrySchema.parse({
    ...unsigned,
    integrityTag: journalIntegrityTag(unsigned, input.integrityKey),
  });
};
