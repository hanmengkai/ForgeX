import { SignedEvidenceSchema, type EvidenceCheck } from "@forgex/contracts";
import { z } from "zod";

import {
  VerificationRunnerTargetSchema,
  type VerificationRunnerTarget,
} from "./model.js";

const artifactEntryBase = {
  schemaVersion: z.literal(1),
  target: VerificationRunnerTargetSchema,
  evidenceKey: z.string().uuid(),
  artifactHashAlgorithm: z.literal("sha256"),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/u),
  artifactContentBase64: z.string().min(1).max(7_000_000),
  checks: z.array(
    z
      .object({
        criterionKey: z.string().uuid(),
        status: z.enum(["passed", "failed"]),
        testRunKey: z.string().trim().min(1).max(200),
      })
      .strict(),
  ),
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

export const VerificationJournalEntrySchema = z.discriminatedUnion("stage", [
  VerificationArtifactJournalEntrySchema,
  VerificationSignedJournalEntrySchema,
]);

export type VerificationArtifactJournalEntry = z.infer<
  typeof VerificationArtifactJournalEntrySchema
>;
export type VerificationSignedJournalEntry = z.infer<
  typeof VerificationSignedJournalEntrySchema
>;
export type VerificationJournalEntry = z.infer<
  typeof VerificationJournalEntrySchema
>;

export interface VerificationJournal {
  load(): Promise<VerificationJournalEntry | null>;
  saveArtifact(entry: VerificationArtifactJournalEntry): Promise<void>;
  saveSigned(entry: VerificationSignedJournalEntry): Promise<void>;
  clear(): Promise<void>;
}

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

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

  async saveSigned(entryInput: VerificationSignedJournalEntry) {
    const entry = VerificationSignedJournalEntrySchema.parse(entryInput);
    if (
      this.#entry &&
      (this.#entry.stage !== "artifact_ready" ||
        !same(
          { ...entry, stage: "artifact_ready", signedEvidence: undefined },
          { ...this.#entry, signedEvidence: undefined },
        ))
    ) {
      if (!same(this.#entry, entry)) {
        throw new Error("已签名证据与待提交 Preview 制品不一致");
      }
    }
    this.#entry = structuredClone(entry);
  }

  async clear(): Promise<void> {
    this.#entry = null;
  }
}

export const verificationArtifactEntry = (input: {
  target: VerificationRunnerTarget;
  evidenceKey: string;
  artifact: Uint8Array;
  artifactHash: string;
  checks: EvidenceCheck[];
}): VerificationArtifactJournalEntry =>
  VerificationArtifactJournalEntrySchema.parse({
    schemaVersion: 1,
    stage: "artifact_ready",
    target: input.target,
    evidenceKey: input.evidenceKey,
    artifactHashAlgorithm: "sha256",
    artifactHash: input.artifactHash,
    artifactContentBase64: Buffer.from(input.artifact).toString("base64"),
    checks: input.checks,
  });
