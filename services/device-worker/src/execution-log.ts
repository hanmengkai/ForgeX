import { appendFile, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  CodexTerminalLogChunkSchema,
  sanitizeExecutionLogText as sanitizeLogText,
  type CodexTerminalLogChunkPayload,
} from "@forgex/contracts";
import { z } from "zod";

const assignmentKeySchema = z.string().uuid();

const samePath = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;

export const sanitizeExecutionLogText = (value: string): string =>
  sanitizeLogText(value).replace(/\r\n?/gu, "\n");

export class RequirementExecutionLogWriter {
  readonly filePath: string;
  #pending = Promise.resolve();

  private constructor(filePath: string) {
    this.filePath = filePath;
  }

  static async open(options: {
    worktreeRoot: string;
    assignmentKey: string;
  }): Promise<RequirementExecutionLogWriter> {
    const assignmentKey = assignmentKeySchema.parse(options.assignmentKey);
    const worktreeRoot = path.normalize(path.resolve(options.worktreeRoot));
    const rootMetadata = await lstat(worktreeRoot);
    if (
      !rootMetadata.isDirectory() ||
      rootMetadata.isSymbolicLink() ||
      !samePath(path.normalize(await realpath(worktreeRoot)), worktreeRoot)
    ) {
      throw new Error("需求日志根目录必须是不可跳转的本地目录");
    }
    const directory = path.join(
      worktreeRoot,
      ".forgex-execution-logs",
      assignmentKey,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = await lstat(directory);
    if (
      !directoryMetadata.isDirectory() ||
      directoryMetadata.isSymbolicLink() ||
      !samePath(path.normalize(await realpath(directory)), directory)
    ) {
      throw new Error("需求日志目录必须是不可跳转的本地目录");
    }
    return new RequirementExecutionLogWriter(
      path.join(directory, "execution.log"),
    );
  }

  append(input: {
    occurredAt: string;
    stream: CodexTerminalLogChunkPayload["stream"];
    text: string;
  }): Promise<void> {
    const occurredAt = z.iso.datetime().parse(input.occurredAt);
    const chunk = CodexTerminalLogChunkSchema.parse({
      stream: input.stream,
      text: input.text,
    });
    const sanitized = sanitizeExecutionLogText(chunk.text);
    const lines = sanitized.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const content = lines
      .map((line) => `[${occurredAt}] [${chunk.stream}] ${line}\n`)
      .join("");
    this.#pending = this.#pending.then(async () => {
      if (!content) return;
      await appendFile(this.filePath, content, {
        encoding: "utf8",
        flag: "a",
        mode: 0o600,
      });
    });
    return this.#pending;
  }
}
