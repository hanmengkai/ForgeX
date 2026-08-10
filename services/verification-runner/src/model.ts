import { z } from "zod";

import { EvidenceCheckSchema } from "@forgex/contracts";

const internalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

export const VerificationRunnerTargetSchema = z
  .object({
    requirementKey: internalKey,
    requirementRevision: z.number().int().positive().max(10_000),
    repositoryKey: internalKey,
    gitHashAlgorithm: z.enum(["sha1", "sha256"]),
    commitSha: z.string(),
    title: z.string().trim().min(2).max(150),
    goal: z.string().trim().min(4).max(1_500),
    acceptanceCriteria: z
      .array(
        z
          .object({
            criterionKey: internalKey,
            title: z.string().trim().min(2).max(150),
            description: z.string().trim().min(4).max(800),
            priority: z.enum(["must", "should", "could"]),
          })
          .strict(),
      )
      .min(1)
      .max(80),
    previewArtifact: z
      .object({
        artifactHashAlgorithm: z.literal("sha256"),
        artifactHash: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((target, context) => {
    const commitPattern =
      target.gitHashAlgorithm === "sha1"
        ? /^[a-f0-9]{40}$/u
        : /^[a-f0-9]{64}$/u;
    if (!commitPattern.test(target.commitSha)) {
      context.addIssue({
        code: "custom",
        path: ["commitSha"],
        message: "Runner 任务必须绑定完整 Git 提交摘要",
      });
    }
    const criterionKeys = new Set<string>();
    target.acceptanceCriteria.forEach((criterion, index) => {
      if (criterionKeys.has(criterion.criterionKey)) {
        context.addIssue({
          code: "custom",
          path: ["acceptanceCriteria", index, "criterionKey"],
          message: "Runner 任务中的验收条件不能重复",
        });
      }
      criterionKeys.add(criterion.criterionKey);
    });
  });

export type VerificationRunnerTarget = z.infer<
  typeof VerificationRunnerTargetSchema
>;

export const VerificationResultSchema = z
  .object({
    artifact: z.instanceof(Uint8Array),
    checks: z.array(EvidenceCheckSchema).min(1).max(80),
  })
  .strict();

export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export interface VerificationEngine {
  canVerify?(target: VerificationRunnerTarget): Promise<boolean>;
  verify(target: VerificationRunnerTarget): Promise<VerificationResult>;
}

export interface VerificationRunnerScope {
  tenantKey: string;
  projectKey: string;
  repositoryKey: string;
  runnerKey: string;
  keyId: string;
}

export const VerificationRunnerScopeSchema = z
  .object({
    tenantKey: internalKey,
    projectKey: internalKey,
    repositoryKey: internalKey,
    runnerKey: internalKey,
    keyId: internalKey,
  })
  .strict();
