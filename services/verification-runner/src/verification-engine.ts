import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import {
  VerificationRunnerTargetSchema,
  type VerificationEngine,
  type VerificationResult,
  type VerificationRunnerTarget,
} from "./model.js";

const technicalKey = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);

const workspaceReferenceSchema = z
  .object({
    repositoryKey: z.string().uuid(),
    gitHashAlgorithm: z.enum(["sha1", "sha256"]),
    commitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  })
  .strict();

export interface PreparedVerificationWorkspace {
  path: string;
  dispose(): Promise<void>;
}

export interface VerificationWorkspaceProvider {
  prepare(
    reference: z.infer<typeof workspaceReferenceSchema>,
  ): Promise<PreparedVerificationWorkspace>;
}

const suiteResultSchema = z
  .object({
    suiteKey: technicalKey,
    status: z.enum(["passed", "failed"]),
  })
  .strict();

const sandboxResultSchema = z
  .object({ suites: z.array(suiteResultSchema).min(1).max(50) })
  .strict()
  .superRefine((result, context) => {
    const suiteKeys = new Set<string>();
    result.suites.forEach((suite, index) => {
      if (suiteKeys.has(suite.suiteKey)) {
        context.addIssue({
          code: "custom",
          path: ["suites", index, "suiteKey"],
          message: "验证套件结果不能重复",
        });
      }
      suiteKeys.add(suite.suiteKey);
    });
  });

const suitePlanSchema = z
  .object({
    suiteKey: technicalKey,
    name: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .refine(
        (value) =>
          !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value),
        "验证套件名称包含不可见控制字符",
      ),
    criterionKeys: z.array(z.string().uuid()).min(1).max(80),
  })
  .strict()
  .superRefine((suite, context) => {
    if (new Set(suite.criterionKeys).size !== suite.criterionKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["criterionKeys"],
        message: "验证套件不能重复绑定同一验收条件",
      });
    }
  });

export const VerificationSuitePlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    planKey: technicalKey,
    planVersion: z.number().int().positive().max(9_999),
    repositoryKey: z.string().uuid(),
    requirementKey: z.string().uuid(),
    requirementRevision: z.number().int().positive().max(10_000),
    gitHashAlgorithm: z.enum(["sha1", "sha256"]),
    commitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
    suites: z.array(suitePlanSchema).min(1).max(50),
  })
  .strict()
  .superRefine((plan, context) => {
    const suiteKeys = new Set<string>();
    plan.suites.forEach((suite, index) => {
      if (suiteKeys.has(suite.suiteKey)) {
        context.addIssue({
          code: "custom",
          path: ["suites", index, "suiteKey"],
          message: "验证计划中的套件不能重复",
        });
      }
      suiteKeys.add(suite.suiteKey);
    });
  });

export type VerificationSuitePlan = z.infer<typeof VerificationSuitePlanSchema>;

export const VerificationSuitePlanAnchorSchema = z
  .object({
    repositoryKey: z.string().uuid(),
    planKey: technicalKey,
    planVersion: z.number().int().positive().max(9_999),
    planHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export type VerificationSuitePlanAnchor = z.infer<
  typeof VerificationSuitePlanAnchorSchema
>;

export const verificationSuitePlanHash = (
  planInput: VerificationSuitePlan,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify(VerificationSuitePlanSchema.parse(planInput)),
      "utf8",
    )
    .digest("hex");

export interface VerificationSuitePlanProvider {
  planFor(target: VerificationRunnerTarget): Promise<VerificationSuitePlan>;
}

export interface VerificationSandbox {
  run(input: {
    workspacePath: string;
    plan: VerificationSuitePlan;
  }): Promise<z.input<typeof sandboxResultSchema>>;
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const renderPreview = (
  target: VerificationRunnerTarget,
  suites: Array<{ name: string; status: "passed" | "failed" }>,
): Uint8Array<ArrayBuffer> => {
  const passed = suites.every((suite) => suite.status === "passed");
  const headline = passed ? "ForgeX 独立验证通过" : "ForgeX 独立验证未通过";
  const suiteItems = suites
    .map(
      (suite) =>
        `<li><strong>${escapeHtml(suite.name)}</strong><span>${
          suite.status === "passed" ? "通过" : "未通过"
        }</span></li>`,
    )
    .join("");
  const criteriaItems = target.acceptanceCriteria
    .map(
      (criterion) =>
        `<li><strong>${escapeHtml(criterion.title)}</strong><p>${escapeHtml(
          criterion.description,
        )}</p></li>`,
    )
    .join("");
  return new TextEncoder().encode(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(headline)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:0 auto;padding:32px;color:#183129;background:#f7faf8}main{background:#fff;border:1px solid #d7e4dd;border-radius:16px;padding:28px}h1{font-size:1.6rem}h2{margin-top:28px;font-size:1.1rem}ul{padding-left:22px}li{margin:12px 0}li span{margin-left:12px;color:${passed ? "#176b4d" : "#a43d3d"}}p{line-height:1.6}</style>
</head>
<body><main><p>可信验证结果</p><h1>${escapeHtml(headline)}</h1><h2>${escapeHtml(
    target.title,
  )}</h2><p>${escapeHtml(target.goal)}</p><h2>固定验证套件</h2><ul>${suiteItems}</ul><h2>验收条件</h2><ul>${criteriaItems}</ul></main></body>
</html>`);
};

export class FixedSuiteVerificationEngine implements VerificationEngine {
  readonly #workspace: VerificationWorkspaceProvider;
  readonly #sandbox: VerificationSandbox;
  readonly #planProvider: VerificationSuitePlanProvider;
  readonly #trustedPlanHashes = new Map<string, string>();

  constructor(options: {
    workspace: VerificationWorkspaceProvider;
    sandbox: VerificationSandbox;
    planProvider: VerificationSuitePlanProvider;
    trustedPlanAnchors: readonly VerificationSuitePlanAnchor[];
  }) {
    this.#workspace = options.workspace;
    this.#sandbox = options.sandbox;
    this.#planProvider = options.planProvider;
    const anchors = z
      .array(VerificationSuitePlanAnchorSchema)
      .min(1)
      .max(1_000)
      .parse(options.trustedPlanAnchors);
    for (const anchor of anchors) {
      const identity = this.#planIdentity(anchor);
      const existing = this.#trustedPlanHashes.get(identity);
      if (existing && existing !== anchor.planHash) {
        throw new Error("同一验证计划版本不能绑定不同内容摘要");
      }
      this.#trustedPlanHashes.set(identity, anchor.planHash);
    }
  }

  async verify(
    targetInput: VerificationRunnerTarget,
  ): Promise<VerificationResult> {
    const target = VerificationRunnerTargetSchema.parse(targetInput);
    const reference = workspaceReferenceSchema.parse({
      repositoryKey: target.repositoryKey,
      gitHashAlgorithm: target.gitHashAlgorithm,
      commitSha: target.commitSha,
    });
    const plan = VerificationSuitePlanSchema.parse(
      await this.#planProvider.planFor(target),
    );
    this.#assertPlan(target, plan);
    const planHash = verificationSuitePlanHash(plan);
    if (this.#trustedPlanHashes.get(this.#planIdentity(plan)) !== planHash) {
      throw new Error("验证套件计划没有匹配可信的不可变版本锚");
    }
    const workspace = await this.#workspace.prepare(reference);
    try {
      if (!path.isAbsolute(workspace.path)) {
        throw new Error("独立验证工作区必须使用绝对路径");
      }
      const result = sandboxResultSchema.parse(
        await this.#sandbox.run({
          workspacePath: path.resolve(workspace.path),
          plan,
        }),
      );
      const results = new Map(
        result.suites.map((suite) => [suite.suiteKey, suite.status] as const),
      );
      if (
        results.size !== plan.suites.length ||
        plan.suites.some((suite) => !results.has(suite.suiteKey))
      ) {
        throw new Error("验证结果没有精确覆盖可信套件计划");
      }
      const renderedSuites = plan.suites.map((suite) => ({
        name: suite.name,
        status: results.get(suite.suiteKey)!,
      }));
      return {
        artifact: renderPreview(target, renderedSuites),
        checks: target.acceptanceCriteria.map((criterion) => {
          const covering = plan.suites.filter((suite) =>
            suite.criterionKeys.includes(criterion.criterionKey),
          );
          const status = covering.every(
            (suite) => results.get(suite.suiteKey) === "passed",
          )
            ? "passed"
            : "failed";
          const resultHash = createHash("sha256")
            .update(
              JSON.stringify(
                covering.map((suite) => ({
                  suiteKey: suite.suiteKey,
                  status: results.get(suite.suiteKey),
                })),
              ),
              "utf8",
            )
            .digest("hex");
          return {
            criterionKey: criterion.criterionKey,
            status,
            testRunKey: `plan-${plan.planKey}-v${plan.planVersion}-${planHash}-result-${resultHash}`,
          };
        }),
      };
    } finally {
      await workspace.dispose();
    }
  }

  #assertPlan(
    target: VerificationRunnerTarget,
    plan: VerificationSuitePlan,
  ): void {
    if (
      plan.requirementKey !== target.requirementKey ||
      plan.repositoryKey !== target.repositoryKey ||
      plan.requirementRevision !== target.requirementRevision ||
      plan.gitHashAlgorithm !== target.gitHashAlgorithm ||
      plan.commitSha !== target.commitSha
    ) {
      throw new Error("验证套件计划没有绑定当前权威提交");
    }
    const expected = new Set(
      target.acceptanceCriteria.map((criterion) => criterion.criterionKey),
    );
    const covered = new Set(
      plan.suites.flatMap((suite) => suite.criterionKeys),
    );
    if (
      covered.size !== expected.size ||
      [...covered].some((criterionKey) => !expected.has(criterionKey))
    ) {
      throw new Error("验证套件计划没有逐项绑定全部验收条件");
    }
  }

  #planIdentity(input: {
    repositoryKey: string;
    planKey: string;
    planVersion: number;
  }): string {
    return `${input.repositoryKey}:${input.planKey}:${input.planVersion}`;
  }
}
