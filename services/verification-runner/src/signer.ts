import { sign, type KeyObject } from "node:crypto";

import {
  EvidencePayloadSchema,
  SignedEvidenceSchema,
  type EvidencePayload,
  type SignedEvidence,
} from "@forgex/contracts";
import { EvidenceAuthority } from "@forgex/domain";
import { z } from "zod";

const signingIdentitySchema = z
  .object({
    runnerKey: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    keyId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();

export interface RunnerEvidenceSigner {
  sign(payload: EvidencePayload): Promise<SignedEvidence>;
}

export class Ed25519RunnerEvidenceSigner implements RunnerEvidenceSigner {
  readonly #runnerKey: string;
  readonly #keyId: string;
  readonly #privateKey: KeyObject;

  constructor(options: {
    runnerKey: string;
    keyId: string;
    privateKey: KeyObject;
  }) {
    const identity = signingIdentitySchema.safeParse({
      runnerKey: options.runnerKey,
      keyId: options.keyId,
    });
    if (!identity.success) throw new Error("Runner 签名身份格式不正确");
    if (
      options.privateKey.type !== "private" ||
      options.privateKey.asymmetricKeyType !== "ed25519"
    ) {
      throw new Error("Runner 必须使用 Ed25519 私钥签署验证证据");
    }
    this.#runnerKey = identity.data.runnerKey;
    this.#keyId = identity.data.keyId;
    this.#privateKey = options.privateKey;
  }

  async sign(payloadInput: EvidencePayload): Promise<SignedEvidence> {
    const payload = EvidencePayloadSchema.parse(payloadInput);
    if (
      payload.runnerKey !== this.#runnerKey ||
      payload.keyId !== this.#keyId
    ) {
      throw new Error("验证证据与 Runner 签名身份不一致");
    }
    return SignedEvidenceSchema.parse({
      payload,
      signature: sign(
        null,
        Buffer.from(EvidenceAuthority.canonicalPayload(payload), "utf8"),
        this.#privateKey,
      ).toString("base64"),
    });
  }
}
