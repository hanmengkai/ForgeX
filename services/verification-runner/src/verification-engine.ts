import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { parse, type DefaultTreeAdapterTypes } from "parse5";
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

const containerImage = z
  .string()
  .trim()
  .min(20)
  .max(300)
  .regex(
    /^(?:sha256:[a-f0-9]{64}|[a-z0-9]+(?:[._:-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64})$/u,
    "验证镜像必须使用不可变的 sha256 摘要",
  );

const containerArgument = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) => !/[\u0000\r\n]/u.test(value),
    "验证命令参数不能包含换行或空字符",
  );

const previewEntryPath = z
  .string()
  .min(6)
  .max(240)
  .refine(
    (value) => !value.includes("\\"),
    "Preview 入口必须使用 POSIX 相对路径",
  )
  .refine((value) => {
    const segments = value.split("/");
    return (
      segments.every(
        (segment) =>
          segment.length > 0 &&
          segment !== "." &&
          segment !== ".." &&
          /^[a-zA-Z0-9._-]+$/u.test(segment),
      ) && value.toLowerCase().endsWith(".html")
    );
  }, "Preview 入口必须是工作树内的 HTML 文件");

const suiteExecutionSchema = z
  .object({
    image: containerImage,
    command: z
      .array(containerArgument)
      .min(1)
      .max(50)
      .refine(
        ([executable]) =>
          executable !== undefined &&
          /^\/forgex-verifier\/[a-z0-9][a-z0-9._-]{0,79}$/u.test(executable),
        "验证命令必须使用可信镜像内固定的 ForgeX 验证驱动",
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(30 * 60_000),
  })
  .strict();

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
    execution: suiteExecutionSchema,
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
    preview: z.object({ entryPath: previewEntryPath }).strict(),
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
  canHandle?(target: VerificationRunnerTarget): Promise<boolean>;
  planFor(target: VerificationRunnerTarget): Promise<VerificationSuitePlan>;
}

export interface VerificationSandbox {
  run(input: {
    workspacePath: string;
    plan: VerificationSuitePlan;
  }): Promise<z.input<typeof sandboxResultSchema>>;
}

const MAX_PREVIEW_BYTES = 1024 * 1024;
const sameLocalPath = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
const isWithinLocalDirectory = (
  directory: string,
  candidate: string,
): boolean => {
  const root = `${path.resolve(directory)}${path.sep}`;
  const resolvedCandidate = path.resolve(candidate);
  return process.platform === "win32"
    ? resolvedCandidate.toLowerCase().startsWith(root.toLowerCase())
    : resolvedCandidate.startsWith(root);
};
const forbiddenPreviewElements = new Set([
  "applet",
  "base",
  "embed",
  "frame",
  "iframe",
  "link",
  "object",
]);
const previewUrlAttributes = new Set([
  "action",
  "cite",
  "data",
  "formaction",
  "href",
  "poster",
  "src",
  "srcset",
]);
const previewUrlIsSelfContained = (value: string): boolean => {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("#") ||
    /^data:image\/(?:gif|jpeg|png|webp);base64,[a-z0-9+/=]+$/iu.test(trimmed)
  );
};

const assertIsolatedPreviewHtml = (html: string): void => {
  if (/\0/u.test(html) || /@import|url\s*\(/iu.test(html)) {
    throw new Error("Preview 必须是自包含 HTML");
  }
  const document = parse(html, { sourceCodeLocationInfo: true });
  let hasDoctype = false;
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if (node.nodeName === "#documentType" && "name" in node) {
      hasDoctype = node.name.toLowerCase() === "html";
      return;
    }
    if ("tagName" in node) {
      const tagName = node.tagName.toLowerCase();
      if (forbiddenPreviewElements.has(tagName)) {
        throw new Error("Preview 必须是自包含 HTML");
      }
      if (tagName === "meta") {
        const httpEquiv = node.attrs.find(
          (attribute) => attribute.name.toLowerCase() === "http-equiv",
        );
        if (httpEquiv) throw new Error("Preview 必须是自包含 HTML");
      }
      for (const attribute of node.attrs) {
        const name = attribute.name.toLowerCase();
        if (
          name.startsWith("on") ||
          (previewUrlAttributes.has(name) &&
            !previewUrlIsSelfContained(attribute.value))
        ) {
          throw new Error("Preview 必须是自包含 HTML");
        }
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
    if ("content" in node) visit(node.content);
  };
  visit(document);
  if (!hasDoctype) throw new Error("Preview 必须声明 HTML 文档类型");
};

export const readIsolatedPreviewArtifact = async (input: {
  workspacePath: string;
  entryPath: string;
}): Promise<Uint8Array<ArrayBuffer>> => {
  const workspacePath = path.resolve(input.workspacePath);
  const entryPath = previewEntryPath.parse(input.entryPath);
  const [workspaceMetadata, workspaceRealPath] = await Promise.all([
    lstat(workspacePath),
    realpath(workspacePath),
  ]);
  if (
    !workspaceMetadata.isDirectory() ||
    workspaceMetadata.isSymbolicLink() ||
    !sameLocalPath(workspaceRealPath, workspacePath)
  ) {
    throw new Error("Preview 工作树不是可信普通目录");
  }
  const segments = entryPath.split("/");
  let current = workspacePath;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    const last = index === segments.length - 1;
    if (
      metadata.isSymbolicLink() ||
      (last ? !metadata.isFile() : !metadata.isDirectory())
    ) {
      throw new Error("Preview 入口必须是不跳转的普通 HTML 文件");
    }
  }
  const [before, resolvedPreviewPath] = await Promise.all([
    lstat(current),
    realpath(current),
  ]);
  if (
    !sameLocalPath(resolvedPreviewPath, current) ||
    !isWithinLocalDirectory(workspacePath, current)
  ) {
    throw new Error("Preview 入口不能离开权威工作树");
  }
  let handle;
  try {
    handle = await open(
      current,
      process.platform === "win32"
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.dev !== before.dev ||
      metadata.ino !== before.ino ||
      metadata.size < 1 ||
      metadata.size > MAX_PREVIEW_BYTES
    ) {
      throw new Error("Preview 超过允许的文件边界");
    }
    const bytes = Uint8Array.from(await handle.readFile());
    const after = await lstat(current);
    if (
      after.isSymbolicLink() ||
      after.dev !== metadata.dev ||
      after.ino !== metadata.ino ||
      after.size !== metadata.size
    ) {
      throw new Error("Preview 入口在读取期间发生替换");
    }
    let html: string;
    try {
      html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Preview 必须使用 UTF-8 HTML");
    }
    assertIsolatedPreviewHtml(html);
    return bytes;
  } finally {
    await handle?.close();
  }
};

export const assertVerificationSuitePlanTarget = (
  targetInput: VerificationRunnerTarget,
  planInput: VerificationSuitePlan,
): void => {
  const target = VerificationRunnerTargetSchema.parse(targetInput);
  const plan = VerificationSuitePlanSchema.parse(planInput);
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
  const covered = new Set(plan.suites.flatMap((suite) => suite.criterionKeys));
  if (
    covered.size !== expected.size ||
    [...covered].some((criterionKey) => !expected.has(criterionKey))
  ) {
    throw new Error("验证套件计划没有逐项绑定全部验收条件");
  }
};

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
  readonly #previewArtifactReader: typeof readIsolatedPreviewArtifact;
  readonly #trustedPlanHashes = new Map<string, string>();

  constructor(options: {
    workspace: VerificationWorkspaceProvider;
    sandbox: VerificationSandbox;
    planProvider: VerificationSuitePlanProvider;
    previewArtifactReader?: typeof readIsolatedPreviewArtifact;
    trustedPlanAnchors: readonly VerificationSuitePlanAnchor[];
  }) {
    this.#workspace = options.workspace;
    this.#sandbox = options.sandbox;
    this.#planProvider = options.planProvider;
    this.#previewArtifactReader =
      options.previewArtifactReader ?? readIsolatedPreviewArtifact;
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

  async canVerify(targetInput: VerificationRunnerTarget): Promise<boolean> {
    const target = VerificationRunnerTargetSchema.parse(targetInput);
    return this.#planProvider.canHandle
      ? this.#planProvider.canHandle(target)
      : true;
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
    assertVerificationSuitePlanTarget(target, plan);
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
      const allSuitesPassed = renderedSuites.every(
        (suite) => suite.status === "passed",
      );
      return {
        artifact: allSuitesPassed
          ? await this.#previewArtifactReader({
              workspacePath: path.resolve(workspace.path),
              entryPath: plan.preview.entryPath,
            })
          : renderPreview(target, renderedSuites),
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

  #planIdentity(input: {
    repositoryKey: string;
    planKey: string;
    planVersion: number;
  }): string {
    return `${input.repositoryKey}:${input.planKey}:${input.planVersion}`;
  }
}
