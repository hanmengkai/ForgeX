import { generateKeyPairSync, sign as signPayload } from "node:crypto";

import {
  EvidenceAuthority,
  type EvidencePayload,
  type TrustedRunner,
} from "../src/index.js";

export const tenantKey = "11111111-1111-4111-8111-111111111111";
export const projectKey = "22222222-2222-4222-8222-222222222222";
export const repositoryKey = "33333333-3333-4333-8333-333333333333";
export const runnerKey = "44444444-4444-4444-8444-444444444444";
export const runnerKeyId = "55555555-5555-4555-8555-555555555555";
export const fixedNow = new Date("2026-08-10T02:00:00.000Z");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

export const trustedRunner: TrustedRunner = {
  runnerKey,
  keyId: runnerKeyId,
  runnerName: "独立测试 Runner",
  publicKeyBase64: publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64"),
  scopes: [{ tenantKey, projectKey, repositoryKey }],
};

export const createEvidenceAuthority = (
  runners: TrustedRunner[] = [trustedRunner],
) =>
  new EvidenceAuthority({
    runners,
    clock: () => new Date(fixedNow.getTime()),
    maxEvidenceAgeMs: 2 * 60 * 60 * 1_000,
    maxFutureSkewMs: 60_000,
  });

export const signEvidence = (payload: EvidencePayload): string =>
  signPayload(
    null,
    Buffer.from(EvidenceAuthority.canonicalPayload(payload), "utf8"),
    privateKey,
  ).toString("base64");

export const deliveryCandidate = {
  repositoryKey,
  gitHashAlgorithm: "sha1" as const,
  commitSha: "a".repeat(40),
  artifactHashAlgorithm: "sha256" as const,
  artifactHash: "b".repeat(64),
};
