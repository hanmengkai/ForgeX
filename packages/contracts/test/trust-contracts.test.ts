import { describe, expect, it } from "vitest";

import {
  EvidencePayloadSchema,
  SignedEvidenceSchema,
  WorkerRegistrationSchema,
} from "../src/index.js";

const validEvidencePayload = {
  schemaVersion: 1 as const,
  evidenceKey: "11111111-1111-4111-8111-111111111111",
  tenantKey: "22222222-2222-4222-8222-222222222222",
  projectKey: "33333333-3333-4333-8333-333333333333",
  repositoryKey: "44444444-4444-4444-8444-444444444444",
  requirementKey: "55555555-5555-4555-8555-555555555555",
  requirementRevision: 1,
  gitHashAlgorithm: "sha1" as const,
  commitSha: "a".repeat(40),
  runnerKey: "77777777-7777-4777-8777-777777777777",
  keyId: "88888888-8888-4888-8888-888888888888",
  producedAt: "2026-08-10T01:30:00.000Z",
  artifactHashAlgorithm: "sha256" as const,
  artifactHash: "b".repeat(64),
  checks: [
    {
      criterionKey: "66666666-6666-4666-8666-666666666666",
      status: "passed" as const,
      testRunKey: "test-run-1",
    },
  ],
};

describe("可信证据契约", () => {
  it("接受绑定需求版本、提交和产物的签名证据", () => {
    expect(
      SignedEvidenceSchema.safeParse({
        payload: validEvidencePayload,
        signature: Buffer.alloc(64, 3).toString("base64"),
      }).success,
    ).toBe(true);
  });

  it("拒绝额外字段、无效摘要和空验证清单", () => {
    expect(
      EvidencePayloadSchema.safeParse({
        ...validEvidencePayload,
        unsafeOverride: true,
      }).success,
    ).toBe(false);
    expect(
      EvidencePayloadSchema.safeParse({
        ...validEvidencePayload,
        artifactHash: "not-a-sha256",
      }).success,
    ).toBe(false);
    expect(
      EvidencePayloadSchema.safeParse({
        ...validEvidencePayload,
        checks: [],
      }).success,
    ).toBe(false);
  });

  it("拒绝缩写提交、重复验收条件和过大的验证清单", () => {
    expect(
      EvidencePayloadSchema.safeParse({
        ...validEvidencePayload,
        commitSha: "a".repeat(7),
      }).success,
    ).toBe(false);
    expect(
      EvidencePayloadSchema.safeParse({
        ...validEvidencePayload,
        checks: [
          validEvidencePayload.checks[0],
          validEvidencePayload.checks[0],
        ],
      }).success,
    ).toBe(false);
    expect(
      EvidencePayloadSchema.safeParse({
        ...validEvidencePayload,
        checks: Array.from({ length: 501 }, (_, index) => ({
          criterionKey: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
          status: "passed",
          testRunKey: `test-run-${index}`,
        })),
      }).success,
    ).toBe(false);
  });
});

describe("Codex 设备注册契约", () => {
  it("接受人类可识别的设备和账户名称", () => {
    const result = WorkerRegistrationSchema.safeParse({
      schemaVersion: 1,
      deviceName: "设计组工作站",
      accountName: "产品交付一号",
      accountFingerprint: "d".repeat(64),
      capabilities: ["frontend", "product-analysis"],
    });

    expect(result.success).toBe(true);
  });

  it("拒绝无效账户指纹", () => {
    expect(
      WorkerRegistrationSchema.safeParse({
        schemaVersion: 1,
        deviceName: "设计组工作站",
        accountName: "产品交付一号",
        accountFingerprint: "account@example.com",
        capabilities: [],
      }).success,
    ).toBe(false);
  });

  it("拒绝上传 Codex 凭据或其他未知字段", () => {
    expect(
      WorkerRegistrationSchema.safeParse({
        schemaVersion: 1,
        deviceName: "设计组工作站",
        accountName: "产品交付一号",
        accountFingerprint: "d".repeat(64),
        capabilities: [],
        codexToken: "不应上传到控制面",
      }).success,
    ).toBe(false);
  });
});
