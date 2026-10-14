import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  realpath,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  LifecycleTaskResultSchema,
  type LifecycleJob,
  type LifecycleTaskResult,
} from "@forgex/contracts/lifecycle";
import { LocalGitCommandRunner } from "./workspace.js";
import type { LifecycleExecutionAdapter } from "./lifecycle-runtime.js";
import {
  LifecycleTestPlanSchema,
  type LifecycleTestPlan,
} from "./lifecycle-codex-adapter.js";
import { savePrivateBytes } from "./lifecycle-transfer.js";
import { sampleProcessIdentity, stopSampleProcess } from "./sample-process.js";

const sha = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
type Environment = {
  schemaVersion: 1;
  jobKey: string;
  artifactDigest: string;
  commitSha: string;
  port: number;
  environmentKey: string;
  previous: { artifactDigest: string; commitSha: string } | null;
  pid?: number | undefined;
  processIdentity?: string | undefined;
  receipt?: LifecycleTaskResult | undefined;
};
const environmentSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    jobKey: z.string().uuid(),
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/u),
    port: z.number().int().positive().max(65535),
    environmentKey: z.string().uuid(),
    pid: z.number().int().positive().optional(),
    processIdentity: z.string().min(1).max(300).optional(),
    receipt: LifecycleTaskResultSchema.optional(),
    previous: z
      .object({
        artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        commitSha: z.string().regex(/^[a-f0-9]{40}$/u),
      })
      .strict()
      .nullable(),
  })
  .strict();

// 样板 Agent 使用确定模板；真实模型通过 CodexLifecycleAdapter 接入。
export class SampleLifecycleAdapter implements LifecycleExecutionAdapter {
  readonly root: string;
  readonly sourcePath: string;
  readonly businessRuntimePath: string | undefined;
  readonly durableDeployments: boolean;
  readonly git = new LocalGitCommandRunner();
  readonly children = new Set<ChildProcess>();
  readonly environments = new Map<
    string,
    { child: ChildProcess; state: Environment }
  >();
  constructor(options: {
    root: string;
    sourcePath: string;
    businessRuntimePath?: string;
    durableDeployments?: boolean;
  }) {
    this.root = path.resolve(options.root);
    this.sourcePath = path.resolve(options.sourcePath);
    this.businessRuntimePath = options.businessRuntimePath;
    this.durableDeployments = options.durableDeployments ?? false;
  }
  async run(
    job: LifecycleJob,
    signal: AbortSignal,
    recoverOnly: boolean,
    candidate?: { workspacePath: string; commitSha: string },
  ): Promise<LifecycleTaskResult> {
    if (recoverOnly)
      return (
        (await this.recover(job, signal)) ?? {
          status: "blocked",
          reason: "没有已核对的样板执行记录",
        }
      );
    if (job.stage !== "development" || !candidate)
      return this.execute(job, signal);
    if (!this.businessRuntimePath || process.platform !== "darwin")
      throw new Error("AI 样板代码必须使用已支持的 macOS 系统沙箱");
    const head = (
      await this.git.run(["-C", candidate.workspacePath, "rev-parse", "HEAD"])
    ).stdout.trim();
    if (head !== candidate.commitSha)
      throw new Error("AI 样板提交与可信候选不匹配");
    const cached = await this.recover(job, signal);
    if (cached) return cached;
    const businessSource = (
      await this.git.run([
        "-C",
        candidate.workspacePath,
        "show",
        `${candidate.commitSha}:appointment.js`,
      ])
    ).stdout;
    if (Buffer.byteLength(businessSource) > 64 * 1024)
      throw new Error("AI 业务代码超过样板协议限制");
    const bytes = JSON.stringify({
      schemaVersion: 1,
      runtimeDigest: sha(await readFile(this.businessRuntimePath)),
      businessSource,
    });
    const artifactDigest = sha(bytes);
    await this.#saveBytes(
      path.join(this.root, "artifacts", `${artifactDigest}.mjs`),
      bytes,
    );
    const target = await this.#start(
      artifactDigest,
      path.join(this.root, "self-tests", job.jobKey),
      signal,
    );
    try {
      const selfTests = await this.#checks(
        target.url,
        job.input.title.startsWith("修复："),
      );
      const result: LifecycleTaskResult = selfTests.some((c) => !c.passed)
        ? {
            status: "failed",
            reason: `AI 代码真实自测失败：${selfTests
              .filter((c) => !c.passed)
              .map((c) => c.name)
              .join("、")}`,
          }
        : {
            status: "succeeded",
            output: {
              kind: "code",
              summary: "真实 Agent 业务代码已提交，隔离运行与 HTTP 自测通过",
              commitSha: head,
              artifactDigest,
              selfTests,
            },
          };
      await this.#save(
        path.join(this.root, "results", `${job.jobKey}.json`),
        result,
      );
      return result;
    } finally {
      await this.#stop(target.child);
    }
  }
  async testWithPlan(
    job: LifecycleJob,
    signal: AbortSignal,
    raw: LifecycleTestPlan,
  ): Promise<LifecycleTaskResult> {
    if (job.stage !== "testing")
      throw new Error("独立测试计划只能用于测试任务");
    const plan = LifecycleTestPlanSchema.parse(raw);
    if (plan.schemaVersion !== 1)
      return { status: "blocked", reason: "预约样板不支持此测试计划版本" };
    const requirement = job.input.artifacts.find(
      (a) => a.output.kind === "requirements",
    )?.output;
    const repair = job.input.title.startsWith("修复：");
    const titles = [
      "有效预约返回编号",
      "无效预约被拒绝",
      "重复请求保持幂等",
      "预约可以查询",
      ...(repair ? ["预约返回确认说明"] : []),
    ];
    const probes = [
      "create",
      "invalid",
      "idempotency",
      "query",
      ...(repair ? ["display"] : []),
    ];
    if (
      requirement?.kind !== "requirements" ||
      requirement.spec.acceptanceCriteria.length !== titles.length ||
      requirement.spec.acceptanceCriteria.some(
        (c, i) => c.title !== titles[i],
      ) ||
      plan.probes.length !== titles.length ||
      probes.some(
        (probe, i) =>
          !plan.probes.some((p) => p.criterionIndex === i && p.probe === probe),
      )
    )
      return {
        status: "blocked",
        reason: "真实需求或 AI 测试计划超出样板探针协议，不能宣称全部覆盖",
      };
    const cached = await this.recover(job, signal);
    if (cached) return cached;
    const result = await this.#test(job, signal, plan);
    await this.#save(
      path.join(this.root, "results", `${job.jobKey}.json`),
      result,
    );
    return result;
  }
  async execute(
    job: LifecycleJob,
    signal: AbortSignal,
  ): Promise<LifecycleTaskResult> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const cache = path.join(this.root, "results", `${job.jobKey}.json`);
    const cached = await this.recover(job, signal);
    if (cached) return cached;
    let result: LifecycleTaskResult;
    if (job.stage === "requirements_ai") result = this.#requirements(job);
    else if (job.stage === "design_ai")
      result = {
        status: "succeeded",
        output: {
          kind: "design",
          summary: "隔离样板设计方案，等待独立审核",
          architecture: "Node HTTP 预约服务，文件持久化，两个独立环境",
          interfaces: [
            "POST /appointments 提交预约",
            "GET /appointments/:id 查询预约",
            "GET /health 校验制品与健康状态",
          ],
          migrations: [],
          testStrategy: [
            "提交有效预约并检查可查询结果",
            "无效输入拒绝",
            "重复请求幂等且不同内容冲突",
            "修复需求验证预约确认说明",
          ],
          rolloutPlan:
            "构建一次，将同一源文件制品部署到隔离测试环境与隔离生产环境；保留上一制品用于恢复",
        },
      };
    else if (job.stage === "development")
      result = await this.#develop(job, signal);
    else if (job.stage === "testing") result = await this.#test(job, signal);
    else if (
      job.stage === "staging_deploy" ||
      job.stage === "production_deploy"
    )
      result = await this.#deploy(job, signal);
    else result = await this.#rollback(job, signal);
    await this.#save(cache, result);
    return result;
  }
  async recover(
    job: LifecycleJob,
    _signal: AbortSignal,
  ): Promise<LifecycleTaskResult | null> {
    let result = await this.#readResult(
      path.join(this.root, "results", `${job.jobKey}.json`),
    );
    if (
      !result &&
      ["staging_deploy", "production_deploy", "production_rollback"].includes(
        job.stage,
      )
    ) {
      const envKey =
        job.stage === "staging_deploy"
          ? `staging-${job.input.workflowKey}`
          : `production-${job.input.projectKey}-${job.input.repositoryKey}`;
      try {
        const state = environmentSchema.parse(
          JSON.parse(
            await readFile(
              path.join(this.root, "environments", envKey, "deployment.json"),
              "utf8",
            ),
          ),
        );
        if (state.jobKey === job.jobKey) result = state.receipt ?? null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (
      !result ||
      result.status !== "succeeded" ||
      !["deployment", "rollback"].includes(result.output.kind)
    )
      return result;
    const envKey =
      job.stage === "staging_deploy"
        ? `staging-${job.input.workflowKey}`
        : `production-${job.input.projectKey}-${job.input.repositoryKey}`;
    try {
      const state = environmentSchema.parse(
        JSON.parse(
          await readFile(
            path.join(this.root, "environments", envKey, "deployment.json"),
            "utf8",
          ),
        ),
      );
      const health = await fetch(`http://127.0.0.1:${state.port}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      const report = (await health.json()) as {
        healthy: boolean;
        artifactDigest: string;
        environmentKey: string;
      };
      if (
        state.jobKey === job.jobKey &&
        health.ok &&
        report.healthy &&
        report.artifactDigest === state.artifactDigest &&
        report.environmentKey === state.environmentKey
      )
        return result;
    } catch {}
    return {
      status: "blocked",
      reason: "样板发布记录存在，但当前环境健康状态无法核对，请人工处置后恢复",
    };
  }
  async close(): Promise<void> {
    await Promise.all([...this.children].map((child) => this.#stop(child)));
    this.environments.clear();
    if (this.durableDeployments) {
      let names: string[] = [];
      try {
        names = await readdir(path.join(this.root, "environments"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const name of names) {
        const state = environmentSchema.parse(
          JSON.parse(
            await readFile(
              path.join(this.root, "environments", name, "deployment.json"),
              "utf8",
            ),
          ),
        );
        if (state.pid && state.processIdentity) await stopSampleProcess(state);
      }
    }
  }
  #requirements(job: LifecycleJob): LifecycleTaskResult {
    if (!job.input.title.includes("预约"))
      return {
        status: "blocked",
        reason: "隔离样板只支持访客预约；其他业务请配置真实需求与设计 Agent",
      };
    const repair = job.input.title.startsWith("修复：");
    return {
      status: "succeeded",
      output: {
        kind: "requirements",
        summary: "确定模板整理的隔离样板需求，需产品与需求方确认",
        spec: {
          schemaVersion: 1,
          title: job.input.title,
          goal: "访客提交预约，获得编号并能够查询；重复提交保持幂等",
          userStories: [
            { role: "访客", need: "提交姓名和到访时间", value: "提前安排到访" },
          ],
          acceptanceCriteria: [
            {
              title: "有效预约返回编号",
              description: "填写有效姓名与时间后返回可查询编号",
              priority: "must",
            },
            {
              title: "无效预约被拒绝",
              description: "缺少有效姓名或时间时返回明确错误",
              priority: "must",
            },
            {
              title: "重复请求保持幂等",
              description: "同一请求返回同一编号，不同内容重用标识被拒绝",
              priority: "must",
            },
            {
              title: "预约可以查询",
              description: "使用返回的编号能够读取原预约",
              priority: "must",
            },
            ...(repair
              ? [
                  {
                    title: "预约返回确认说明",
                    description: "响应包含明确的预约确认说明",
                    priority: "must" as const,
                  },
                ]
              : []),
          ],
          openQuestions: [],
        },
      },
    };
  }
  async #develop(
    job: LifecycleJob,
    signal: AbortSignal,
  ): Promise<LifecycleTaskResult> {
    const source = await readFile(this.sourcePath, "utf8");
    const program = job.input.title.startsWith("修复：")
      ? source.replace(
          "const includeDisplay = false;",
          "const includeDisplay = true;",
        )
      : source;
    const repository = path.join(
      this.root,
      "repositories",
      job.input.workflowKey,
    );
    await mkdir(repository, { recursive: true, mode: 0o700 });
    try {
      const top = (
        await this.git.run(["-C", repository, "rev-parse", "--show-toplevel"])
      ).stdout.trim();
      if (top !== (await realpath(repository)))
        throw new Error("必须初始化独立样板仓库");
    } catch {
      await this.git.run(["-C", repository, "init", "-q", "-b", "main"]);
    }
    await writeFile(path.join(repository, "app.mjs"), program, { mode: 0o600 });
    await this.git.run(["-C", repository, "add", "--", "app.mjs"]);
    await this.git.run([
      "-C",
      repository,
      "-c",
      "user.name=ForgeX 样板执行器",
      "-c",
      "user.email=p0-sample@forgex.local",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-q",
      "--allow-empty",
      "--no-verify",
      "-m",
      "实现：隔离样板预约交付",
    ]);
    const commitSha = (
      await this.git.run(["-C", repository, "rev-parse", "HEAD"])
    ).stdout.trim();
    const artifactDigest = sha(program);
    const artifact = path.join(this.root, "artifacts", `${artifactDigest}.mjs`);
    await this.#saveBytes(artifact, program);
    const target = await this.#start(
      artifactDigest,
      path.join(this.root, "self-tests", job.jobKey),
      signal,
    );
    try {
      const checks = await this.#checks(
        target.url,
        job.input.title.startsWith("修复："),
      );
      if (checks.some((c) => !c.passed))
        return { status: "failed", reason: "隔离样板构建后自测未通过" };
      return {
        status: "succeeded",
        output: {
          kind: "code",
          summary: "隔离样板已生成真实 Git 提交与源文件制品，HTTP 自测通过",
          commitSha,
          artifactDigest,
          selfTests: checks.map((c) => ({ name: c.name, passed: c.passed })),
        },
      };
    } finally {
      await this.#stop(target.child);
    }
  }
  async #test(
    job: LifecycleJob,
    signal: AbortSignal,
    plan?: LifecycleTestPlan,
  ): Promise<LifecycleTaskResult> {
    const code = job.input.artifacts.find(
      (a) => a.output.kind === "code",
    )?.output;
    if (code?.kind !== "code")
      return { status: "blocked", reason: "没有已审核代码制品" };
    const requirement = job.input.artifacts.find(
      (a) => a.output.kind === "requirements",
    )?.output;
    if (requirement?.kind !== "requirements")
      return { status: "blocked", reason: "没有已确认需求" };
    const target = await this.#start(
      code.artifactDigest,
      path.join(this.root, "independent-tests", job.jobKey),
      signal,
    );
    try {
      const checks = await this.#checks(
        target.url,
        requirement.spec.acceptanceCriteria.length === 5,
      );
      if (
        checks.length !== requirement.spec.acceptanceCriteria.length ||
        checks.some((c) => !c.passed)
      )
        return { status: "failed", reason: "独立样板业务测试失败或覆盖不匹配" };
      return {
        status: "succeeded",
        output: {
          kind: "tests",
          summary: "独立执行器实际运行 HTTP 业务测试，全部验收条件通过",
          commitSha: code.commitSha,
          artifactDigest: code.artifactDigest,
          checks: checks.map((c, criterionIndex) => ({ ...c, criterionIndex })),
          planDigest: sha(
            JSON.stringify({
              version: 1,
              ...(plan ? { agentPlan: plan } : {}),
              criteria: requirement.spec.acceptanceCriteria,
              tests: [
                "create",
                "invalid",
                "idempotency-conflict",
                "query",
                "display",
              ],
            }),
          ),
        },
      };
    } finally {
      await this.#stop(target.child);
    }
  }
  async #deploy(
    job: LifecycleJob,
    signal: AbortSignal,
  ): Promise<LifecycleTaskResult> {
    const code = job.input.artifacts.find(
      (a) => a.output.kind === "code",
    )?.output;
    if (code?.kind !== "code")
      return { status: "blocked", reason: "没有可部署的已验证制品" };
    const environment =
      job.stage === "staging_deploy" ? "staging" : "production";
    const envKey =
      environment === "staging"
        ? `staging-${job.input.workflowKey}`
        : `production-${job.input.projectKey}-${job.input.repositoryKey}`;
    const root = path.join(this.root, "environments", envKey);
    let previous: Environment | null = null;
    try {
      previous = environmentSchema.parse(
        JSON.parse(await readFile(path.join(root, "deployment.json"), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const live = this.environments.get(envKey);
    if (live) await this.#stop(live.child);
    else if (previous?.pid && previous.processIdentity)
      await stopSampleProcess(previous);
    const started = await this.#start(
      code.artifactDigest,
      root,
      signal,
      previous?.port,
      this.durableDeployments,
    );
    const state: Environment = {
      schemaVersion: 1,
      jobKey: job.jobKey,
      artifactDigest: code.artifactDigest,
      commitSha: code.commitSha,
      port: started.port,
      environmentKey: started.environmentKey,
      previous: previous
        ? {
            artifactDigest: previous.artifactDigest,
            commitSha: previous.commitSha,
          }
        : null,
      ...(this.durableDeployments
        ? {
            pid: started.child.pid!,
            processIdentity: await sampleProcessIdentity(started.child.pid!),
          }
        : {}),
    };
    const result: LifecycleTaskResult = {
      status: "succeeded",
      output: {
        kind: "deployment",
        summary: `隔离样板${environment === "staging" ? "测试" : "生产"}环境已实际部署并通过制品健康检查`,
        environment,
        commitSha: code.commitSha,
        artifactDigest: code.artifactDigest,
        url: started.url,
        healthy: true,
        deploymentKey: job.jobKey,
      },
    };
    state.receipt = result;
    await this.#save(path.join(root, "deployment.json"), state);
    this.environments.set(envKey, { child: started.child, state });
    return result;
  }
  async #rollback(
    job: LifecycleJob,
    signal: AbortSignal,
  ): Promise<LifecycleTaskResult> {
    const envKey = `production-${job.input.projectKey}-${job.input.repositoryKey}`;
    const root = path.join(this.root, "environments", envKey);
    let previous: Environment;
    try {
      previous = environmentSchema.parse(
        JSON.parse(await readFile(path.join(root, "deployment.json"), "utf8")),
      );
    } catch {
      return { status: "blocked", reason: "隔离生产环境没有可核对的发布记录" };
    }
    if (previous.jobKey !== job.input.productionJobKey || !previous.previous)
      return {
        status: "blocked",
        reason: "无法确认原发布或不存在上一制品，请人工处置",
      };
    const live = this.environments.get(envKey);
    if (live) await this.#stop(live.child);
    else if (previous.pid && previous.processIdentity)
      await stopSampleProcess(previous);
    const started = await this.#start(
      previous.previous.artifactDigest,
      root,
      signal,
      previous.port,
      this.durableDeployments,
    );
    const state: Environment = {
      ...previous,
      jobKey: job.jobKey,
      artifactDigest: previous.previous.artifactDigest,
      commitSha: previous.previous.commitSha,
      environmentKey: started.environmentKey,
      previous: null,
      ...(this.durableDeployments
        ? {
            pid: started.child.pid!,
            processIdentity: await sampleProcessIdentity(started.child.pid!),
          }
        : {}),
    };
    const result: LifecycleTaskResult = {
      status: "succeeded",
      output: {
        kind: "rollback",
        summary: "隔离生产环境已实际恢复上一制品，健康检查通过",
        productionJobKey: job.input.productionJobKey,
        healthy: true,
      },
    };
    state.receipt = result;
    await this.#save(path.join(root, "deployment.json"), state);
    this.environments.set(envKey, { child: started.child, state });
    return result;
  }
  async #start(
    artifactDigest: string,
    root: string,
    signal: AbortSignal,
    port = 0,
    durable = false,
  ): Promise<{
    child: ChildProcess;
    url: string;
    port: number;
    environmentKey: string;
  }> {
    const artifact = path.join(this.root, "artifacts", `${artifactDigest}.mjs`);
    const bytes = await readFile(artifact);
    if (sha(bytes) !== artifactDigest) throw new Error("样板制品摘要不匹配");
    let businessArtifact: {
      schemaVersion: 1;
      runtimeDigest: string;
      businessSource: string;
    } | null = null;
    if (this.businessRuntimePath) {
      businessArtifact = z
        .object({
          schemaVersion: z.literal(1),
          runtimeDigest: z.string().regex(/^[a-f0-9]{64}$/u),
          businessSource: z.string().max(64 * 1024),
        })
        .strict()
        .parse(JSON.parse(bytes.toString("utf8")));
      if (
        process.platform !== "darwin" ||
        businessArtifact.runtimeDigest !==
          sha(await readFile(this.businessRuntimePath))
      )
        throw new Error("AI 样板运行时或系统沙箱不符合已批准版本");
    }
    const trusted = await readFile(this.sourcePath, "utf8");
    if (
      !businessArtifact &&
      bytes.toString("utf8") !== trusted &&
      bytes.toString("utf8") !==
        trusted.replace(
          "const includeDisplay = false;",
          "const includeDisplay = true;",
        )
    )
      throw new Error("样板执行器拒绝运行未经审核的任意代码");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const environmentKey = randomUUID();
    const nodePath = await realpath(process.execPath);
    const runtime = businessArtifact
      ? await realpath(this.businessRuntimePath!)
      : artifact;
    const nodeArguments = [
      "--permission",
      `--allow-fs-read=${artifact}`,
      `--allow-fs-read=${runtime}`,
      `--allow-fs-read=${root}`,
      `--allow-fs-write=${root}`,
      runtime,
      ...(businessArtifact ? [artifact] : []),
    ];
    // 系统限制覆盖 VM 与 Node 权限之外的能力；不允许任意业务代码连接本机其他服务。
    const quoted = (value: string) => JSON.stringify(value);
    const profile = `(version 1)(allow default)(deny file-read* file-write*)(allow file-read-metadata)(allow file-read* (literal "/") (subpath "/System") (subpath "/usr") (subpath "/private/preboot") (subpath "/private/var/db/dyld") (subpath "/opt/homebrew") (subpath "/Library/Apple") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal ${quoted(nodePath)}) (literal ${quoted(runtime)}) (literal ${quoted(artifact)}) (subpath ${quoted(root)}))(allow file-write* (subpath ${quoted(root)}) (literal "/dev/null"))(deny network-outbound)(deny process-fork)(deny process-exec)(allow process-exec (literal ${quoted(nodePath)}))`;
    const child = spawn(
      businessArtifact ? "/usr/bin/sandbox-exec" : nodePath,
      businessArtifact
        ? ["-p", profile, nodePath, ...nodeArguments]
        : nodeArguments,
      {
        env: {
          FORGEX_SAMPLE_DATA_FILE: path.join(root, "appointments.json"),
          FORGEX_SAMPLE_ARTIFACT_DIGEST: artifactDigest,
          FORGEX_SAMPLE_ENVIRONMENT_KEY: environmentKey,
          FORGEX_SAMPLE_PORT: String(port),
          FORGEX_SAMPLE_VERIFY: ["self-tests", "independent-tests"].some(
            (name) => root.startsWith(path.join(this.root, name) + path.sep),
          )
            ? "1"
            : "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
        ...(durable ? { detached: true } : { signal }),
      },
    );
    this.children.add(child);
    child.once("exit", () => this.children.delete(child));
    child.on("error", () => {});
    try {
      const actualPort = await new Promise<number>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        child.stderr!.on("data", (chunk) => {
          if (stderr.length < 1000) stderr += String(chunk);
        });
        const timer = setTimeout(
          () => reject(new Error("样板环境启动超时")),
          10_000,
        );
        const cleanup = () => clearTimeout(timer);
        child.once("error", (error) => {
          cleanup();
          reject(error);
        });
        child.once("exit", (code, exitSignal) => {
          cleanup();
          reject(
            new Error(
              `样板进程启动失败（${code ?? exitSignal}）：${stderr.slice(0, 500)}`,
            ),
          );
        });
        child.stdout!.on("data", (chunk) => {
          stdout += String(chunk);
          if (stdout.length > 4096) {
            cleanup();
            reject(new Error("样板进程返回内容过大"));
            return;
          }
          const line = stdout.split("\n")[0];
          if (!stdout.includes("\n")) return;
          try {
            const data = z
              .object({ port: z.number().int().positive().max(65535) })
              .strict()
              .parse(JSON.parse(line!));
            cleanup();
            resolve(data.port);
          } catch {
            cleanup();
            reject(new Error("样板进程返回内容格式错误"));
          }
        });
      });
      const url = `http://127.0.0.1:${actualPort}`;
      const health = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      const report = (await health.json()) as {
        healthy: boolean;
        artifactDigest: string;
        environmentKey: string;
      };
      if (
        !health.ok ||
        !report.healthy ||
        report.artifactDigest !== artifactDigest ||
        report.environmentKey !== environmentKey
      )
        throw new Error("样板健康状态未绑定正确制品");
      if (durable) {
        child.unref();
        child.stdout!.destroy();
        child.stderr!.destroy();
      }
      return { child, url, port: actualPort, environmentKey };
    } catch (error) {
      await this.#stop(child);
      throw error;
    }
  }
  async #checks(url: string, repair: boolean) {
    const post = (body: unknown) =>
      fetch(`${url}/appointments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
    const payload = {
      name: "访客张三",
      visitAt: "2030-01-01T10:00:00Z",
      requestKey: randomUUID(),
    };
    const response = await post(payload);
    const created = (await response.json()) as {
      id?: string;
      name?: string;
      display?: string;
    };
    const invalid = await post({
      name: "",
      visitAt: "无效",
      requestKey: randomUUID(),
    });
    const repeated = await post(payload);
    const duplicate = (await repeated.json()) as { id?: string };
    const conflict = await post({ ...payload, name: "访客李四" });
    const found = await fetch(`${url}/appointments/${created.id}`, {
      signal: AbortSignal.timeout(5_000),
    });
    const record = (await found.json()) as { id?: string; name?: string };
    const checks = [
      {
        name: "有效预约返回编号",
        passed:
          response.status === 201 &&
          z.string().uuid().safeParse(created.id).success,
      },
      { name: "无效预约被拒绝", passed: invalid.status === 400 },
      {
        name: "重复请求幂等且冲突被拒绝",
        passed:
          repeated.status === 200 &&
          duplicate.id === created.id &&
          conflict.status === 409,
      },
      {
        name: "预约可查询且数据一致",
        passed:
          found.status === 200 &&
          record.id === created.id &&
          record.name === payload.name,
      },
      ...(repair
        ? [{ name: "预约确认说明", passed: created.display === "预约已确认" }]
        : []),
    ];
    if (this.businessRuntimePath) {
      const response = await fetch(`${url}/__forgex_contract_probes`, {
        signal: AbortSignal.timeout(10_000),
      });
      const result = z
        .object({
          create: z.boolean(),
          invalid: z.boolean(),
          idempotency: z.boolean(),
          query: z.boolean(),
          display: z.boolean(),
        })
        .strict()
        .parse(await response.json());
      for (const [index, probe] of (
        [
          "create",
          "invalid",
          "idempotency",
          "query",
          ...(repair ? ["display"] : []),
        ] as (keyof typeof result)[]
      ).entries())
        checks[index]!.passed &&= response.ok && result[probe];
    }
    return checks;
  }
  async #stop(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
  async #readResult(file: string): Promise<LifecycleTaskResult | null> {
    try {
      return LifecycleTaskResultSchema.parse(
        JSON.parse(await readFile(file, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async #save(file: string, value: unknown): Promise<void> {
    await this.#saveBytes(file, JSON.stringify(value));
  }
  async #saveBytes(file: string, value: string): Promise<void> {
    await savePrivateBytes(file, Buffer.from(value));
  }
}
