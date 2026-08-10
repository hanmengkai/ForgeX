import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import {
  WORKER_MCP_FAILED_SUMMARY,
  WORKER_MCP_SUCCEEDED_SUMMARY,
  WORKER_MCP_UNKNOWN_SUMMARY,
} from "@forgex/contracts";

import { McpWorkerAssignmentSchema } from "./control-plane-client.js";

const execFileAsync = promisify(execFile);

const internalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const hash = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const lease = {
  assignmentKey: internalKey,
  fencingToken: z.number().int().positive(),
  title: z.string().trim().min(2).max(150),
} as const;

export const PendingWorkerCompletionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("requirement_delivery"),
      assignment: z
        .object({
          ...lease,
          projectKey: internalKey,
          repositoryKey: internalKey,
          requirementKey: internalKey,
          requirementRevision: z.number().int().positive().max(10_000),
        })
        .strict(),
      result: z
        .object({
          summary: z.string().trim().min(2).max(500),
          branchName: z
            .string()
            .trim()
            .min(1)
            .max(250)
            .regex(/^forgex\/[a-f0-9-]+\/[a-f0-9-]+$/u),
          baseCommit: hash,
          commitSha: hash,
          gitHashAlgorithm: z.enum(["sha1", "sha256"]),
        })
        .strict(),
    })
    .strict()
    .superRefine((completion, context) => {
      const length = completion.result.gitHashAlgorithm === "sha1" ? 40 : 64;
      if (
        completion.result.baseCommit.length !== length ||
        completion.result.commitSha.length !== length ||
        completion.result.baseCommit === completion.result.commitSha
      ) {
        context.addIssue({
          code: "custom",
          path: ["result", "commitSha"],
          message: "完成日志中的 Git 提交绑定无效",
        });
      }
    }),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("mcp_invocation"),
      assignment: z
        .object({
          ...lease,
          projectKey: internalKey,
          invocationKey: internalKey,
        })
        .strict(),
      result: z.discriminatedUnion("outcome", [
        z
          .object({
            outcome: z.literal("succeeded"),
            summary: z.literal(WORKER_MCP_SUCCEEDED_SUMMARY),
          })
          .strict(),
        z
          .object({
            outcome: z.literal("failed"),
            summary: z.literal(WORKER_MCP_FAILED_SUMMARY),
          })
          .strict(),
        z
          .object({
            outcome: z.literal("unknown"),
            summary: z.literal(WORKER_MCP_UNKNOWN_SUMMARY),
          })
          .strict(),
      ]),
    })
    .strict(),
]);

export type PendingWorkerCompletion = z.infer<
  typeof PendingWorkerCompletionSchema
>;
export type PendingRequirementCompletion = Extract<
  PendingWorkerCompletion,
  { kind: "requirement_delivery" }
>;
export type PendingMcpCompletion = Extract<
  PendingWorkerCompletion,
  { kind: "mcp_invocation" }
>;

export const PendingMcpExecutionIntentSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("mcp_invocation_started"),
    assignment: McpWorkerAssignmentSchema,
  })
  .strict();

export type PendingMcpExecutionIntent = z.infer<
  typeof PendingMcpExecutionIntentSchema
>;

export const PendingRequirementCommitSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("requirement_commit_pending"),
    assignment: PendingWorkerCompletionSchema.options[0].shape.assignment,
    workspace: z
      .object({
        path: z
          .string()
          .trim()
          .min(1)
          .max(1_000)
          .refine(
            (value) => path.isAbsolute(value),
            "工作树路径必须是绝对路径",
          ),
        branchName:
          PendingWorkerCompletionSchema.options[0].shape.result.shape
            .branchName,
        baseCommit: hash,
      })
      .strict(),
    summary: z.string().trim().min(2).max(500),
  })
  .strict();

export type PendingRequirementCommit = z.infer<
  typeof PendingRequirementCommitSchema
>;
export type WorkerJournalEntry =
  | PendingWorkerCompletion
  | PendingRequirementCommit
  | PendingMcpExecutionIntent;

const assertCompletionMatchesIntent = (
  intent: PendingRequirementCommit | PendingMcpExecutionIntent,
  completion: PendingWorkerCompletion,
): void => {
  if (intent.kind === "mcp_invocation_started") {
    if (
      completion.kind !== "mcp_invocation" ||
      completion.assignment.assignmentKey !== intent.assignment.assignmentKey ||
      completion.assignment.fencingToken !== intent.assignment.fencingToken ||
      completion.assignment.projectKey !== intent.assignment.projectKey ||
      completion.assignment.invocationKey !== intent.assignment.invocationKey ||
      completion.assignment.title !== intent.assignment.title ||
      (intent.assignment.execution.effect === "read" &&
        completion.result.outcome === "unknown")
    ) {
      throw new Error("MCP 执行结果与持久化执行意图不一致");
    }
    return;
  }
  if (
    completion.kind !== "requirement_delivery" ||
    JSON.stringify(completion.assignment) !==
      JSON.stringify(intent.assignment) ||
    completion.result.summary !== intent.summary ||
    completion.result.branchName !== intent.workspace.branchName ||
    completion.result.baseCommit !== intent.workspace.baseCommit
  ) {
    throw new Error("设备提交结果与持久化提交意图不一致");
  }
};

export interface WorkerCompletionJournal {
  load(): Promise<WorkerJournalEntry | null>;
  save(completion: PendingWorkerCompletion): Promise<void>;
  saveCommitIntent(intent: PendingRequirementCommit): Promise<void>;
  saveMcpIntent(intent: PendingMcpExecutionIntent): Promise<void>;
  clear(): Promise<void>;
  quarantine(
    completion: PendingWorkerCompletion,
    reason: { code: string; message: string },
  ): Promise<void>;
}

const missingFile = (error: unknown): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";

const syncParentDirectory = async (target: string): Promise<void> => {
  const directory = await open(path.dirname(target), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};

const windowsDurableMove = async (
  source: string,
  destination: string,
): Promise<void> => {
  const script = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ForgeXJournalNative {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool MoveFileEx(string source, string destination, int flags);
}
'@
$source = $env:FORGEX_JOURNAL_SOURCE
$destination = $env:FORGEX_JOURNAL_DESTINATION
if (-not [ForgeXJournalNative]::MoveFileEx($source, $destination, 9)) {
  $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "MoveFileEx failed with Win32 error $errorCode"
}
`;
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      timeout: 15_000,
      env: {
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        FORGEX_JOURNAL_SOURCE: source,
        FORGEX_JOURNAL_DESTINATION: destination,
      },
    },
  );
};

const durableReplace = async (
  source: string,
  destination: string,
): Promise<void> => {
  if (process.platform === "win32") {
    await windowsDurableMove(source, destination);
    return;
  }
  await rename(source, destination);
  await syncParentDirectory(destination);
};

const durableDelete = async (target: string): Promise<void> => {
  try {
    await lstat(target);
  } catch (error) {
    if (missingFile(error)) return;
    throw error;
  }
  if (process.platform === "win32") {
    const tombstone = `${target}.deleted-${process.pid}-${randomUUID()}`;
    await windowsDurableMove(target, tombstone);
    try {
      await unlink(tombstone);
    } catch (error) {
      if (!missingFile(error)) throw error;
    }
    return;
  }
  await unlink(target);
  await syncParentDirectory(target);
};

export class FileWorkerCompletionJournal implements WorkerCompletionJournal {
  readonly #filePath: string;
  readonly #intentPath: string;

  constructor(filePath: string) {
    if (!path.isAbsolute(filePath)) {
      throw new Error("设备完成日志必须使用绝对路径");
    }
    this.#filePath = path.resolve(filePath);
    this.#intentPath = `${this.#filePath}.intent`;
  }

  async load(): Promise<WorkerJournalEntry | null> {
    try {
      const metadata = await lstat(this.#filePath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > 1_048_576
      ) {
        throw new Error("设备完成日志不是可信的普通小文件");
      }
      const parsed: unknown = JSON.parse(
        await readFile(this.#filePath, "utf8"),
      );
      return PendingWorkerCompletionSchema.parse(parsed);
    } catch (error) {
      if (!missingFile(error)) throw error;
    }
    try {
      const metadata = await lstat(this.#intentPath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > 1_048_576
      ) {
        throw new Error("设备提交意图不是可信的普通小文件");
      }
      const parsed: unknown = JSON.parse(
        await readFile(this.#intentPath, "utf8"),
      );
      return z
        .union([
          PendingRequirementCommitSchema,
          PendingMcpExecutionIntentSchema,
        ])
        .parse(parsed);
    } catch (error) {
      if (missingFile(error)) return null;
      throw error;
    }
  }

  async save(completion: PendingWorkerCompletion): Promise<void> {
    const parsed = PendingWorkerCompletionSchema.parse(completion);
    const current = await this.load();
    if (
      current?.kind === "requirement_commit_pending" ||
      current?.kind === "mcp_invocation_started"
    ) {
      assertCompletionMatchesIntent(current, parsed);
    }
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    try {
      const metadata = await lstat(this.#filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("设备完成日志目标不能是符号链接或特殊文件");
      }
      const existing = PendingWorkerCompletionSchema.parse(
        JSON.parse(await readFile(this.#filePath, "utf8")) as unknown,
      );
      if (JSON.stringify(existing) === JSON.stringify(parsed)) return;
      throw new Error("未确认的设备完成日志不能被另一项结果覆盖");
    } catch (error) {
      if (!missingFile(error)) throw error;
    }
    const temporaryPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(parsed), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await durableReplace(temporaryPath, this.#filePath);
      try {
        await durableDelete(this.#intentPath);
      } catch (error) {
        if (!missingFile(error)) throw error;
      }
    } catch (error) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (!missingFile(cleanupError)) {
          throw new AggregateError(
            [error, cleanupError],
            "设备完成日志替换失败且临时文件未能清理",
          );
        }
      }
      throw error;
    }
  }

  async saveCommitIntent(intent: PendingRequirementCommit): Promise<void> {
    await this.#saveIntent(PendingRequirementCommitSchema.parse(intent));
  }

  async saveMcpIntent(intent: PendingMcpExecutionIntent): Promise<void> {
    await this.#saveIntent(PendingMcpExecutionIntentSchema.parse(intent));
  }

  async #saveIntent(
    parsed: PendingRequirementCommit | PendingMcpExecutionIntent,
  ): Promise<void> {
    const current = await this.load();
    if (current) {
      if (JSON.stringify(current) === JSON.stringify(parsed)) return;
      throw new Error("未确认的设备结果存在时不能开始另一个执行意图");
    }
    await mkdir(path.dirname(this.#intentPath), { recursive: true });
    const temporaryPath = `${this.#intentPath}.${process.pid}.${randomUUID()}.tmp`;
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(parsed), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await durableReplace(temporaryPath, this.#intentPath);
    } catch (error) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (!missingFile(cleanupError)) {
          throw new AggregateError(
            [error, cleanupError],
            "设备执行意图写入失败且临时文件未能清理",
          );
        }
      }
      throw error;
    }
  }

  async clear(): Promise<void> {
    // 先删意图再删完成记录：若进程在两次删除之间崩溃，仍会优先恢复完成记录，
    // 不会让已经上报成功的旧提交意图重新复活。
    for (const target of [this.#intentPath, this.#filePath]) {
      try {
        const metadata = await lstat(target);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new Error("设备完成日志目标不能是符号链接或特殊文件");
        }
        await durableDelete(target);
      } catch (error) {
        if (!missingFile(error)) throw error;
      }
    }
  }

  async quarantine(
    completion: PendingWorkerCompletion,
    reason: { code: string; message: string },
  ): Promise<void> {
    const parsed = PendingWorkerCompletionSchema.parse(completion);
    const current = await this.load();
    if (!current || JSON.stringify(current) !== JSON.stringify(parsed)) {
      throw new Error("待隔离的设备完成结果与当前持久日志不一致");
    }
    const safeCode = reason.code.replace(/[^a-z0-9_-]/giu, "_").slice(0, 80);
    const conflictPath = `${this.#filePath}.conflict-${parsed.assignment.assignmentKey}-${parsed.assignment.fencingToken}-${safeCode}.json`;
    const file = await open(conflictPath, "wx", 0o600);
    try {
      await file.writeFile(
        JSON.stringify({
          schemaVersion: 1,
          quarantinedAt: new Date().toISOString(),
          reason: {
            code: safeCode || "completion_conflict",
            message: reason.message.slice(0, 500),
          },
          completion: parsed,
        }),
        "utf8",
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await this.clear();
  }
}

export class InMemoryWorkerCompletionJournal implements WorkerCompletionJournal {
  #pending: WorkerJournalEntry | null = null;
  readonly conflicts: Array<{
    completion: PendingWorkerCompletion;
    reason: { code: string; message: string };
  }> = [];

  async load(): Promise<WorkerJournalEntry | null> {
    return this.#pending ? structuredClone(this.#pending) : null;
  }

  async save(completion: PendingWorkerCompletion): Promise<void> {
    const parsed = PendingWorkerCompletionSchema.parse(completion);
    if (
      this.#pending?.kind === "requirement_commit_pending" ||
      this.#pending?.kind === "mcp_invocation_started"
    ) {
      assertCompletionMatchesIntent(this.#pending, parsed);
    } else if (this.#pending) {
      if (JSON.stringify(this.#pending) === JSON.stringify(parsed)) return;
      throw new Error("未确认的设备完成日志不能被另一项结果覆盖");
    }
    this.#pending = structuredClone(parsed);
  }

  async saveCommitIntent(intent: PendingRequirementCommit): Promise<void> {
    const parsed = PendingRequirementCommitSchema.parse(intent);
    if (this.#pending) {
      if (JSON.stringify(this.#pending) === JSON.stringify(parsed)) return;
      throw new Error("未确认的设备结果存在时不能开始另一个提交意图");
    }
    this.#pending = structuredClone(parsed);
  }

  async saveMcpIntent(intent: PendingMcpExecutionIntent): Promise<void> {
    const parsed = PendingMcpExecutionIntentSchema.parse(intent);
    if (this.#pending) {
      if (JSON.stringify(this.#pending) === JSON.stringify(parsed)) return;
      throw new Error("未确认的设备结果存在时不能开始另一个执行意图");
    }
    this.#pending = structuredClone(parsed);
  }

  async clear(): Promise<void> {
    this.#pending = null;
  }

  async quarantine(
    completion: PendingWorkerCompletion,
    reason: { code: string; message: string },
  ): Promise<void> {
    const parsed = PendingWorkerCompletionSchema.parse(completion);
    if (
      !this.#pending ||
      this.#pending.kind === "requirement_commit_pending" ||
      this.#pending.kind === "mcp_invocation_started" ||
      JSON.stringify(this.#pending) !== JSON.stringify(parsed)
    ) {
      throw new Error("待隔离的设备完成结果与当前持久日志不一致");
    }
    this.conflicts.push({
      completion: structuredClone(parsed),
      reason: { ...reason },
    });
    this.#pending = null;
  }
}
