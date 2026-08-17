import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CodexTerminalLogChunkSchema,
  sanitizeExecutionLogText,
  type ExecutionLogStream,
} from "@forgex/contracts";
import { z } from "zod";

const internalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const scopeSchema = z
  .object({
    tenantKey: internalKey,
    projectKey: internalKey,
    requirementKey: internalKey,
    requirementRevision: z.number().int().positive().max(10_000),
  })
  .strict();
const attemptScopeSchema = scopeSchema
  .extend({ assignmentKey: internalKey })
  .strict();
const chunkSchema = CodexTerminalLogChunkSchema.extend({
  chunkKey: internalKey,
  sequence: z.number().int().positive().max(1_000_000),
  occurredAt: z.iso.datetime(),
}).strict();

export interface ExecutionLogScope {
  tenantKey: string;
  projectKey: string;
  requirementKey: string;
  requirementRevision: number;
}

export interface ExecutionLogAttemptScope extends ExecutionLogScope {
  assignmentKey: string;
}

export interface ExecutionLogChunk {
  chunkKey: string;
  sequence: number;
  occurredAt: string;
  stream: ExecutionLogStream;
  text: string;
}

export interface ExecutionLogLine {
  occurredAt: string;
  stream: ExecutionLogStream;
  text: string;
}

export interface ExecutionLogSnapshot {
  assignmentKey: string | null;
  totalLines: number;
  truncated: boolean;
  updatedAt: string | null;
  lines: ExecutionLogLine[];
}

export interface ExecutionLogStore {
  append(
    scope: ExecutionLogAttemptScope,
    chunk: ExecutionLogChunk,
  ): Promise<boolean>;
  readLatest(
    scope: ExecutionLogScope,
    tailLines: number | null,
  ): Promise<ExecutionLogSnapshot>;
}

interface StoredAttempt {
  assignmentKey: string;
  chunks: Map<string, ExecutionLogChunk>;
}

const normalizedChunk = (chunk: ExecutionLogChunk): ExecutionLogChunk => {
  const parsed = chunkSchema.parse(chunk);
  return {
    ...parsed,
    text: sanitizeExecutionLogText(parsed.text).replace(/\r\n?/gu, "\n"),
  };
};

const scopeIdentity = (scope: ExecutionLogScope): string =>
  [
    scope.tenantKey,
    scope.projectKey,
    scope.requirementKey,
    String(scope.requirementRevision),
  ].join(":");

const chunkLines = (chunk: ExecutionLogChunk): ExecutionLogLine[] => {
  const values = chunk.text.split("\n");
  if (values.at(-1) === "") values.pop();
  return values.map((text) => ({
    occurredAt: chunk.occurredAt,
    stream: chunk.stream,
    text,
  }));
};

const attemptSnapshot = (
  attempt: StoredAttempt | null,
  tailLines: number | null,
): ExecutionLogSnapshot => {
  if (!attempt) {
    return {
      assignmentKey: null,
      totalLines: 0,
      truncated: false,
      updatedAt: null,
      lines: [],
    };
  }
  const chunks = [...attempt.chunks.values()].sort(
    (left, right) =>
      left.sequence - right.sequence ||
      left.occurredAt.localeCompare(right.occurredAt) ||
      left.chunkKey.localeCompare(right.chunkKey),
  );
  const lines = chunks.flatMap(chunkLines);
  const selected = tailLines === null ? lines : lines.slice(-tailLines);
  return {
    assignmentKey: attempt.assignmentKey,
    totalLines: lines.length,
    truncated: selected.length < lines.length,
    updatedAt: chunks.at(-1)?.occurredAt ?? null,
    lines: selected,
  };
};

const assertTailLines = (value: number | null): void => {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) {
    throw new Error("日志尾部行数必须是正整数或 null");
  }
};

const latestAttempt = (attempts: StoredAttempt[]): StoredAttempt | null =>
  attempts.reduce<StoredAttempt | null>((latest, attempt) => {
    if (!latest) return attempt;
    const latestAt = [...latest.chunks.values()].reduce(
      (value, chunk) => (chunk.occurredAt > value ? chunk.occurredAt : value),
      "",
    );
    const attemptAt = [...attempt.chunks.values()].reduce(
      (value, chunk) => (chunk.occurredAt > value ? chunk.occurredAt : value),
      "",
    );
    return attemptAt > latestAt ||
      (attemptAt === latestAt && attempt.assignmentKey > latest.assignmentKey)
      ? attempt
      : latest;
  }, null);

export class InMemoryExecutionLogStore implements ExecutionLogStore {
  readonly #attempts = new Map<string, Map<string, StoredAttempt>>();

  async append(
    rawScope: ExecutionLogAttemptScope,
    rawChunk: ExecutionLogChunk,
  ): Promise<boolean> {
    const scope = attemptScopeSchema.parse(rawScope);
    const chunk = normalizedChunk(rawChunk);
    const identity = scopeIdentity(scope);
    const attempts = this.#attempts.get(identity) ?? new Map();
    const attempt = attempts.get(scope.assignmentKey) ?? {
      assignmentKey: scope.assignmentKey,
      chunks: new Map(),
    };
    const existing = attempt.chunks.get(chunk.chunkKey);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(chunk)) {
        throw new Error("同一执行日志分片不能绑定不同内容");
      }
      return false;
    }
    attempt.chunks.set(chunk.chunkKey, structuredClone(chunk));
    attempts.set(scope.assignmentKey, attempt);
    this.#attempts.set(identity, attempts);
    return true;
  }

  async readLatest(
    rawScope: ExecutionLogScope,
    tailLines: number | null,
  ): Promise<ExecutionLogSnapshot> {
    const scope = scopeSchema.parse(rawScope);
    assertTailLines(tailLines);
    return structuredClone(
      attemptSnapshot(
        latestAttempt([
          ...(this.#attempts.get(scopeIdentity(scope))?.values() ?? []),
        ]),
        tailLines,
      ),
    );
  }
}

const chunkFilePattern =
  /^(\d{9})-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-(\d{13})-(stdout|stderr|system)\.log$/u;

const readDirectory = async (directory: string) => {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

export class FileSystemExecutionLogStore implements ExecutionLogStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  #requirementDirectory(scope: ExecutionLogScope): string {
    return path.join(
      this.#root,
      scope.tenantKey,
      scope.projectKey,
      scope.requirementKey,
      `v${String(scope.requirementRevision).padStart(4, "0")}`,
    );
  }

  async append(
    rawScope: ExecutionLogAttemptScope,
    rawChunk: ExecutionLogChunk,
  ): Promise<boolean> {
    const scope = attemptScopeSchema.parse(rawScope);
    const chunk = normalizedChunk(rawChunk);
    const directory = path.join(
      this.#requirementDirectory(scope),
      scope.assignmentKey,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const existingEntry = (await readDirectory(directory)).find(
      (entry) => entry.isFile() && entry.name.includes(`-${chunk.chunkKey}-`),
    );
    if (existingEntry) {
      const existing = await this.#readChunk(
        scope.assignmentKey,
        directory,
        existingEntry.name,
      );
      if (
        !existing ||
        JSON.stringify(existing.chunks.get(chunk.chunkKey)) !==
          JSON.stringify(chunk)
      ) {
        throw new Error("同一执行日志分片不能绑定不同内容");
      }
      return false;
    }
    const fileName =
      [
        String(chunk.sequence).padStart(9, "0"),
        chunk.chunkKey,
        String(Date.parse(chunk.occurredAt)),
        chunk.stream,
      ].join("-") + ".log";
    try {
      await writeFile(path.join(directory, fileName), chunk.text, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.#readChunk(
        scope.assignmentKey,
        directory,
        fileName,
      );
      if (
        JSON.stringify(existing?.chunks.get(chunk.chunkKey)) !==
        JSON.stringify(chunk)
      ) {
        throw new Error("同一执行日志分片不能绑定不同内容");
      }
      return false;
    }
  }

  async readLatest(
    rawScope: ExecutionLogScope,
    tailLines: number | null,
  ): Promise<ExecutionLogSnapshot> {
    const scope = scopeSchema.parse(rawScope);
    assertTailLines(tailLines);
    const directory = this.#requirementDirectory(scope);
    const attempts = await Promise.all(
      (await readDirectory(directory))
        .filter(
          (entry) =>
            entry.isDirectory() && internalKey.safeParse(entry.name).success,
        )
        .map((entry) =>
          this.#readAttempt(entry.name, path.join(directory, entry.name)),
        ),
    );
    return attemptSnapshot(
      latestAttempt(attempts.filter((attempt) => attempt.chunks.size > 0)),
      tailLines,
    );
  }

  async #readAttempt(
    assignmentKey: string,
    directory: string,
  ): Promise<StoredAttempt> {
    const attempts = await Promise.all(
      (await readDirectory(directory))
        .filter((entry) => entry.isFile() && chunkFilePattern.test(entry.name))
        .map((entry) => this.#readChunk(assignmentKey, directory, entry.name)),
    );
    const chunks = new Map<string, ExecutionLogChunk>();
    for (const attempt of attempts) {
      if (!attempt) continue;
      for (const [key, chunk] of attempt.chunks) chunks.set(key, chunk);
    }
    return { assignmentKey, chunks };
  }

  async #readChunk(
    assignmentKey: string,
    directory: string,
    fileName: string,
  ): Promise<StoredAttempt | null> {
    const match = chunkFilePattern.exec(fileName);
    if (!match) return null;
    const [, rawSequence, chunkKey, rawOccurredAt, stream] = match;
    const chunk = normalizedChunk({
      chunkKey: chunkKey!,
      sequence: Number(rawSequence),
      occurredAt: new Date(Number(rawOccurredAt)).toISOString(),
      stream: stream as ExecutionLogStream,
      text: await readFile(path.join(directory, fileName), "utf8"),
    });
    return {
      assignmentKey,
      chunks: new Map([[chunk.chunkKey, chunk]]),
    };
  }
}
