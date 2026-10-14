import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { z } from "zod";
import {
  LifecycleTaskResultSchema,
  type LifecycleJob,
  type LifecycleTaskResult,
} from "@forgex/contracts/lifecycle";
import {
  NodeLifecycleTestPlanSchema,
  type LifecycleCandidatePipeline,
  type LifecycleTestPlan,
} from "./lifecycle-codex-adapter.js";
import { assertLifecyclePrivatePath } from "./lifecycle-runtime.js";
import { savePrivateBytes, savePrivateJson } from "./lifecycle-transfer.js";
import { LocalGitCommandRunner } from "./workspace.js";
import { sampleProcessIdentity, stopSampleProcess } from "./sample-process.js";

const digest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const sourceName = z
  .string()
  .regex(/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.ts$/u);
const checkSchema = z
  .object({ name: z.string().min(2).max(500), passed: z.boolean() })
  .strict();
const catalogSchema = z
  .array(
    z
      .object({
        title: z.string().min(2).max(500),
        suiteKey: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
      })
      .strict(),
  )
  .min(1)
  .max(200);
export const NodeProjectConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    root: z.string().refine(path.isAbsolute),
    entrypoint: sourceName,
    sourceFiles: z.array(sourceName).min(1).max(100),
    runtimePath: z.string().refine(path.isAbsolute),
    runtimeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    suitesPath: z.string().refine(path.isAbsolute),
    suitesSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

// 编译器只读取登记源码和自带标准库，不读取候选配置或外部依赖。
export function compileNodeProject(
  sources: Record<string, string>,
  entrypoint: string,
) {
  sourceName.parse(entrypoint);
  const files = Object.keys(sources);
  if (!files.length || files.length > 100 || !files.includes(entrypoint))
    throw new Error("Node 项目入口或源码清单不正确");
  files.forEach((file) => sourceName.parse(file));
  if (
    Object.values(sources).reduce((n, v) => n + Buffer.byteLength(v), 0) >
    64 * 1024
  )
    throw new Error("Node 项目源码超过当前协议限制");
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    strict: true,
    noEmitOnError: true,
    skipLibCheck: true,
    types: [],
    lib: ["lib.es2022.d.ts"],
    rootDir: "/forgex",
    outDir: "/compiled",
  };
  const host = ts.createCompilerHost(options),
    originalRead = host.readFile,
    libRoot = path.dirname(ts.getDefaultLibFilePath(options));
  const allowedLib = (file: string) =>
    path.dirname(file) === libRoot &&
    /^lib\.[a-z0-9.]+\.d\.ts$/u.test(path.basename(file));
  host.readFile = (file) =>
    file.startsWith("/forgex/")
      ? sources[file.slice(8)]
      : allowedLib(file)
        ? originalRead(file)
        : undefined;
  host.fileExists = (file) => host.readFile(file) !== undefined;
  host.directoryExists = (dir) => dir.startsWith("/forgex") || dir === libRoot;
  const modules: Record<string, string> = Object.create(null);
  host.writeFile = (file, text) => {
    if (!file.startsWith("/compiled/") || !file.endsWith(".js"))
      throw new Error("编译输出越过登记范围");
    modules[file.slice(10)] = text;
  };
  const program = ts.createProgram(
    files.map((f) => `/forgex/${f}`),
    options,
    host,
  );
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length)
    throw new Error(
      `TypeScript 编译失败：${ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, " ").slice(0, 400)}`,
    );
  if (program.emit().emitSkipped)
    throw new Error("TypeScript 编译失败，未生成制品");
  return { entrypoint: entrypoint.replace(/\.ts$/u, ".js"), modules };
}
export function validateNodeTestPlan(
  raw: unknown,
  count: number,
  suiteKeys: string[],
) {
  const plan = NodeLifecycleTestPlanSchema.parse(raw);
  if (
    plan.cases.length !== count ||
    new Set(plan.cases.map((c) => c.criterionIndex)).size !== count ||
    plan.cases.some(
      (c) => c.criterionIndex >= count || !suiteKeys.includes(c.suiteKey),
    )
  )
    throw new Error("独立测试计划存在缺漏、重复或未登记套件");
  return plan;
}
const deploymentSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobKey: z.string().uuid(),
    inputDigest: z.string(),
    pid: z.number().int().positive(),
    processIdentity: z.string(),
    port: z.number().int().positive(),
    environmentKey: z.string().uuid(),
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    receipt: LifecycleTaskResultSchema,
  })
  .strict();
type Deployment = z.infer<typeof deploymentSchema>;

export class NodeProjectLifecyclePipeline implements LifecycleCandidatePipeline {
  readonly root: string;
  readonly testPlanSchema = NodeLifecycleTestPlanSchema;
  readonly git = new LocalGitCommandRunner();
  constructor(readonly options: z.infer<typeof NodeProjectConfigSchema>) {
    NodeProjectConfigSchema.parse(options);
    this.root = path.resolve(options.root);
  }
  async #trusted() {
    if (process.platform !== "darwin")
      throw new Error("Node 项目执行仅支持已验证的 macOS 系统沙箱");
    for (const [file, expected] of [
      [this.options.runtimePath, this.options.runtimeSha256],
      [this.options.suitesPath, this.options.suitesSha256],
    ]) {
      if (
        (await realpath(file!)) !== file ||
        digest(await readFile(file!)) !== expected
      )
        throw new Error("受信 Node 运行时或测试套件版本发生变化");
    }
    const suites = (await import(
      pathToFileURL(this.options.suitesPath).href
    )) as {
      catalog: unknown;
      runSuite: (key: string, url: string) => Promise<unknown>;
    };
    const catalog = catalogSchema.parse(suites.catalog);
    if (
      new Set(catalog.map((c) => c.title)).size !== catalog.length ||
      new Set(catalog.map((c) => c.suiteKey)).size !== catalog.length ||
      typeof suites.runSuite !== "function"
    )
      throw new Error("受信独立测试目录格式不正确");
    return { suites, catalog };
  }
  async #save(job: LifecycleJob, result: LifecycleTaskResult) {
    await savePrivateJson(
      path.join(this.root, "results", `${job.jobKey}.json`),
      { schemaVersion: 1, inputDigest: job.inputDigest, result },
    );
    return result;
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
          reason: "没有可核对的 Node 项目执行记录",
        }
      );
    if (job.stage !== "development" || !candidate)
      return this.execute(job, signal);
    const cached = await this.recover(job, signal);
    if (cached) return cached;
    const { suites, catalog } = await this.#trusted();
    if (
      !/^[a-f0-9]{40}$/u.test(candidate.commitSha) ||
      (
        await this.git.run(["-C", candidate.workspacePath, "rev-parse", "HEAD"])
      ).stdout.trim() !== candidate.commitSha
    )
      throw new Error("Node 项目候选未绑定可信提交");
    const sources: Record<string, string> = Object.create(null);
    for (const file of this.options.sourceFiles)
      sources[file] = (
        await this.git.run([
          "-C",
          candidate.workspacePath,
          "show",
          `${candidate.commitSha}:${file}`,
        ])
      ).stdout;
    const compiled = compileNodeProject(sources, this.options.entrypoint);
    const bytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        runtimeDigest: this.options.runtimeSha256,
        ...compiled,
      }),
    );
    if (bytes.length > 128 * 1024)
      throw new Error("Node 项目制品超过交接协议限制");
    const artifactDigest = digest(bytes);
    await savePrivateBytes(this.#artifact(artifactDigest), bytes);
    const target = await this.#start(
      artifactDigest,
      path.join(this.root, "self-tests", job.jobKey),
      signal,
    );
    try {
      const checks = await this.#checks(job, suites, catalog, target.url);
      if (checks.some((c) => !c.passed))
        return this.#save(job, {
          status: "failed",
          reason: `实际项目自测失败：${checks
            .filter((c) => !c.passed)
            .map((c) => c.name)
            .join("、")
            .slice(0, 400)}`,
        });
      return this.#save(job, {
        status: "succeeded",
        output: {
          kind: "code",
          summary: "TypeScript 严格编译及真实 HTTP 自测通过",
          commitSha: candidate.commitSha,
          artifactDigest,
          selfTests: checks,
        },
      });
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
    const { suites, catalog } = await this.#trusted();
    const requirement = job.input.artifacts.find(
      (a) => a.output.kind === "requirements",
    )?.output;
    const code = job.input.artifacts.find(
      (a) => a.output.kind === "code",
    )?.output;
    if (requirement?.kind !== "requirements" || code?.kind !== "code")
      return { status: "blocked", reason: "缺少已批准需求或代码制品" };
    const criteria = requirement.spec.acceptanceCriteria;
    const plan = validateNodeTestPlan(
      raw,
      criteria.length,
      catalog.map((c) => c.suiteKey),
    );
    if (
      plan.cases.some(
        (c) =>
          catalog.find((s) => s.suiteKey === c.suiteKey)?.title !==
          criteria[c.criterionIndex]?.title,
      )
    )
      return {
        status: "blocked",
        reason: "需求验收条件与受信套件的覆盖绑定不一致",
      };
    const cached = await this.recover(job, signal);
    if (cached) return cached;
    const target = await this.#start(
      code.artifactDigest,
      path.join(this.root, "independent-tests", job.jobKey),
      signal,
    );
    try {
      const checks = await this.#checks(
        job,
        suites,
        plan.cases.map((c) => ({
          suiteKey: c.suiteKey,
          title: criteria[c.criterionIndex]!.title,
          criterionIndex: c.criterionIndex,
        })),
        target.url,
      );
      if (checks.some((c) => !c.passed))
        return this.#save(job, {
          status: "failed",
          reason: "实际项目独立 HTTP 测试失败",
        });
      return this.#save(job, {
        status: "succeeded",
        output: {
          kind: "tests",
          summary: "独立执行器运行登记套件，全部验收条件通过",
          commitSha: code.commitSha,
          artifactDigest: code.artifactDigest,
          checks: checks.map((c, i) => ({
            ...c,
            criterionIndex: plan.cases[i]!.criterionIndex,
          })),
          planDigest: digest(
            JSON.stringify({
              schemaVersion: 2,
              plan,
              criteria,
              suitesSha256: this.options.suitesSha256,
            }),
          ),
        },
      });
    } finally {
      await this.#stop(target.child);
    }
  }
  async #checks(
    job: LifecycleJob,
    suites: { runSuite: (key: string, url: string) => Promise<unknown> },
    catalog: { title: string; suiteKey: string }[],
    url: string,
  ) {
    const groups = [];
    for (const item of catalog) {
      let checks: z.infer<typeof checkSchema>[];
      try {
        checks = z
          .array(checkSchema)
          .min(1)
          .max(200)
          .parse(
            await Promise.race([
              suites.runSuite(item.suiteKey, url),
              new Promise((_, reject) => {
                const timer = setTimeout(
                  () => reject(new Error("受信套件执行超时")),
                  30_000,
                );
                timer.unref();
              }),
            ]),
          );
      } catch {
        checks = [{ name: "受信套件执行异常", passed: false }];
      }
      groups.push({
        name: item.title,
        passed: checks.every((c) => c.passed),
        details: checks,
        suiteKey: item.suiteKey,
      });
    }
    await savePrivateJson(
      path.join(this.root, "test-evidence", `${job.jobKey}.json`),
      { schemaVersion: 1, suitesSha256: this.options.suitesSha256, groups },
    );
    return groups.map(({ name, passed }) => ({ name, passed }));
  }
  async execute(
    job: LifecycleJob,
    signal: AbortSignal,
  ): Promise<LifecycleTaskResult> {
    if (job.stage !== "staging_deploy")
      return {
        status: "blocked",
        reason:
          "本项目适配器仅允许已审核代码测试和测试环境部署，未启用生产能力",
      };
    const cached = await this.recover(job, signal);
    if (cached) return cached;
    await this.#trusted();
    const code = job.input.artifacts.find(
      (a) => a.output.kind === "code",
    )?.output;
    if (code?.kind !== "code")
      return { status: "blocked", reason: "缺少已验证代码制品" };
    const target = await this.#start(
      code.artifactDigest,
      path.join(this.root, "environments", job.jobKey),
      signal,
      true,
    );
    const receipt: LifecycleTaskResult = {
      status: "succeeded",
      output: {
        kind: "deployment",
        summary: "任务看板已部署测试环境，制品与健康状态核对通过",
        environment: "staging",
        commitSha: code.commitSha,
        artifactDigest: code.artifactDigest,
        url: target.url,
        healthy: true,
        deploymentKey: job.jobKey,
      },
    };
    try {
      await savePrivateJson(
        path.join(this.root, "deployments", `${job.jobKey}.json`),
        {
          schemaVersion: 1,
          jobKey: job.jobKey,
          inputDigest: job.inputDigest,
          pid: target.child.pid!,
          processIdentity: await sampleProcessIdentity(target.child.pid!),
          port: target.port,
          environmentKey: target.environmentKey,
          artifactDigest: code.artifactDigest,
          receipt,
        },
      );
      return this.#save(job, receipt);
    } catch (error) {
      await this.#stop(target.child);
      throw error;
    }
  }
  async recover(
    job: LifecycleJob,
    _signal: AbortSignal,
  ): Promise<LifecycleTaskResult | null> {
    let result: LifecycleTaskResult | null = null;
    try {
      const file = path.join(
        this.root,
        "results",
        `${z.string().uuid().parse(job.jobKey)}.json`,
      );
      await assertLifecyclePrivatePath(file);
      const record = z
        .object({
          schemaVersion: z.literal(1),
          inputDigest: z.string(),
          result: LifecycleTaskResultSchema,
        })
        .strict()
        .parse(JSON.parse(await readFile(file, "utf8")));
      if (record.inputDigest !== job.inputDigest)
        throw new Error("Node 项目回执输入摘要不一致");
      result = record.result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (job.stage !== "staging_deploy") return result;
    const deployed = await this.#deployment(job.jobKey);
    if (!deployed) return null;
    const code = job.input.artifacts.find(
      (a) => a.output.kind === "code",
    )?.output;
    const receipt = deployed.receipt;
    if (
      deployed.jobKey !== job.jobKey ||
      code?.kind !== "code" ||
      receipt.status !== "succeeded" ||
      receipt.output.kind !== "deployment" ||
      receipt.output.environment !== "staging" ||
      receipt.output.commitSha !== code.commitSha ||
      receipt.output.artifactDigest !== code.artifactDigest ||
      deployed.artifactDigest !== code.artifactDigest ||
      receipt.output.deploymentKey !== job.jobKey ||
      receipt.output.url !== `http://127.0.0.1:${deployed.port}` ||
      !receipt.output.healthy
    )
      throw new Error("测试环境恢复回执未绑定原任务及获批制品");
    if (
      deployed.inputDigest !== job.inputDigest ||
      (await sampleProcessIdentity(deployed.pid)) !== deployed.processIdentity
    )
      throw new Error("测试环境原发布身份发生变化");
    await this.#health(
      deployed.port,
      deployed.artifactDigest,
      deployed.environmentKey,
    );
    return deployed.receipt;
  }
  async stopDeployment(jobKey: string) {
    const deployed = await this.#deployment(jobKey);
    if (deployed) await stopSampleProcess(deployed);
  }
  async #deployment(jobKey: string): Promise<Deployment | null> {
    const file = path.join(
      this.root,
      "deployments",
      `${z.string().uuid().parse(jobKey)}.json`,
    );
    try {
      await assertLifecyclePrivatePath(file);
      return deploymentSchema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  #artifact(hash: string) {
    z.string()
      .regex(/^[a-f0-9]{64}$/u)
      .parse(hash);
    return path.join(this.root, "artifacts", `${hash}.mjs`);
  }
  async #health(port: number, artifactDigest: string, environmentKey: string) {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const health = (await response.json()) as Record<string, unknown>;
    if (
      !response.ok ||
      health.healthy !== true ||
      health.artifactDigest !== artifactDigest ||
      health.environmentKey !== environmentKey
    )
      throw new Error("Node 测试环境健康状态未绑定原制品及环境");
  }
  async #start(
    hash: string,
    root: string,
    signal: AbortSignal,
    durable = false,
  ) {
    const artifact = this.#artifact(hash),
      bytes = await readFile(artifact);
    if (
      digest(bytes) !== hash ||
      JSON.parse(bytes.toString("utf8")).runtimeDigest !==
        this.options.runtimeSha256
    )
      throw new Error("Node 项目制品摘要或运行时不一致");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await assertLifecyclePrivatePath(root);
    const node = await realpath(process.execPath),
      runtime = this.options.runtimePath,
      environmentKey = randomUUID(),
      q = JSON.stringify;
    const profile = `(version 1)(allow default)(deny file-read* file-write*)(allow file-read-metadata)(allow file-read* (literal "/") (subpath "/System") (subpath "/usr") (subpath "/private/preboot") (subpath "/private/var/db/dyld") (subpath "/Library/Apple") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal ${q(node)}) (literal ${q(runtime)}) (literal ${q(artifact)}) (subpath ${q(root)}))(allow file-write* (subpath ${q(root)}) (literal "/dev/null"))(deny network-outbound)(deny process-fork)(deny process-exec)(allow process-exec (literal ${q(node)}))`;
    const child = spawn(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        profile,
        node,
        "--permission",
        `--allow-fs-read=${artifact}`,
        `--allow-fs-read=${runtime}`,
        `--allow-fs-read=${root}`,
        `--allow-fs-write=${root}`,
        runtime,
        artifact,
      ],
      {
        env: {
          FORGEX_PROJECT_DATA_FILE: path.join(root, "state.json"),
          FORGEX_PROJECT_ARTIFACT_DIGEST: hash,
          FORGEX_PROJECT_ENVIRONMENT_KEY: environmentKey,
        },
        stdio: ["ignore", "pipe", "pipe"],
        ...(durable ? { detached: true } : { signal }),
      },
    );
    child.on("error", () => {});
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let output = "",
          error = "";
        const timer = setTimeout(
          () =>
            reject(new Error(`Node 测试环境启动超时：${error.slice(0, 300)}`)),
          10000,
        );
        child.stderr!.on("data", (c) => {
          if (error.length < 1000) error += String(c);
        });
        child.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(`Node 测试进程启动失败：${error.slice(0, 400)}`));
        });
        child.stdout!.on("data", (c) => {
          output += String(c);
          if (output.length > 4096) {
            clearTimeout(timer);
            reject(new Error("Node 测试进程启动返回超限"));
          } else if (output.includes("\n")) {
            clearTimeout(timer);
            try {
              resolve(
                z
                  .object({ port: z.number().int().positive().max(65535) })
                  .strict()
                  .parse(JSON.parse(output.split("\n")[0]!)).port,
              );
            } catch {
              reject(new Error("Node 测试进程启动协议错误"));
            }
          }
        });
      });
      await this.#health(port, hash, environmentKey);
      if (durable) {
        child.unref();
        child.stdout!.destroy();
        child.stderr!.destroy();
      }
      return { child, port, environmentKey, url: `http://127.0.0.1:${port}` };
    } catch (error) {
      await this.#stop(child);
      throw error;
    }
  }
  async #stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      timer.unref();
    });
  }
}
