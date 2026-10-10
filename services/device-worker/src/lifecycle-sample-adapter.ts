import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  LifecycleTaskResultSchema,
  type LifecycleJob,
  type LifecycleTaskResult,
} from "@forgex/contracts/lifecycle";
import { LocalGitCommandRunner } from "./workspace.js";
import type { LifecycleExecutionAdapter } from "./lifecycle-runtime.js";

const sha = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
type Environment = {
  jobKey: string;
  artifactDigest: string;
  commitSha: string;
  port: number;
  environmentKey: string;
  previous: { artifactDigest: string; commitSha: string } | null;
};
const environmentSchema = z
  .object({
    jobKey: z.string().uuid(),
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/u),
    port: z.number().int().positive().max(65535),
    environmentKey: z.string().uuid(),
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
  readonly git = new LocalGitCommandRunner();
  readonly children = new Set<ChildProcess>();
  readonly environments = new Map<
    string,
    { child: ChildProcess; state: Environment }
  >();
  constructor(options: { root: string; sourcePath: string }) {
    this.root = path.resolve(options.root);
    this.sourcePath = path.resolve(options.sourcePath);
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
    const result = await this.#readResult(
      path.join(this.root, "results", `${job.jobKey}.json`),
    );
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
      await this.git.run(["-C", repository, "rev-parse", "--git-dir"]);
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
    const started = await this.#start(
      code.artifactDigest,
      root,
      signal,
      previous?.port,
    );
    const state: Environment = {
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
    };
    await this.#save(path.join(root, "deployment.json"), state);
    this.environments.set(envKey, { child: started.child, state });
    return {
      status: "succeeded",
      output: {
        kind: "deployment",
        summary: `隔离样板${environment === "staging" ? "测试" : "生产"}环境已实际部署并通过制品健康检查`,
        environment,
        commitSha: code.commitSha,
        artifactDigest: code.artifactDigest,
        url: started.url,
        healthy: true,
        deploymentKey: randomUUID(),
      },
    };
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
    const started = await this.#start(
      previous.previous.artifactDigest,
      root,
      signal,
      previous.port,
    );
    const state: Environment = {
      ...previous,
      jobKey: job.jobKey,
      artifactDigest: previous.previous.artifactDigest,
      commitSha: previous.previous.commitSha,
      environmentKey: started.environmentKey,
      previous: null,
    };
    await this.#save(path.join(root, "deployment.json"), state);
    this.environments.set(envKey, { child: started.child, state });
    return {
      status: "succeeded",
      output: {
        kind: "rollback",
        summary: "隔离生产环境已实际恢复上一制品，健康检查通过",
        productionJobKey: job.input.productionJobKey,
        healthy: true,
      },
    };
  }
  async #start(
    artifactDigest: string,
    root: string,
    signal: AbortSignal,
    port = 0,
  ): Promise<{
    child: ChildProcess;
    url: string;
    port: number;
    environmentKey: string;
  }> {
    const artifact = path.join(this.root, "artifacts", `${artifactDigest}.mjs`);
    const bytes = await readFile(artifact);
    if (sha(bytes) !== artifactDigest) throw new Error("样板制品摘要不匹配");
    const trusted = await readFile(this.sourcePath, "utf8");
    if (
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
    const child = spawn(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${artifact}`,
        `--allow-fs-read=${root}`,
        `--allow-fs-write=${root}`,
        artifact,
      ],
      {
        env: {
          FORGEX_SAMPLE_DATA_FILE: path.join(root, "appointments.json"),
          FORGEX_SAMPLE_ARTIFACT_DIGEST: artifactDigest,
          FORGEX_SAMPLE_ENVIRONMENT_KEY: environmentKey,
          FORGEX_SAMPLE_PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      },
    );
    this.children.add(child);
    child.once("exit", () => this.children.delete(child));
    child.on("error", () => {});
    try {
      const actualPort = await new Promise<number>((resolve, reject) => {
        let stdout = "";
        const timer = setTimeout(
          () => reject(new Error("样板环境启动超时")),
          10_000,
        );
        const cleanup = () => clearTimeout(timer);
        child.once("error", (error) => {
          cleanup();
          reject(error);
        });
        child.once("exit", () => {
          cleanup();
          reject(new Error("样板进程启动失败"));
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
    return [
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
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, value, { mode: 0o600 });
    await rename(temporary, file);
  }
}
