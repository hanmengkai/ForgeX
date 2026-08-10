import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const missingFile = (error: unknown): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";

interface LockDescriptor {
  schemaVersion: 1;
  state: "active";
  identityHash: string;
  ownerToken: string;
  processId: number;
  processStartKey: string;
}

const uuidPattern = /^[a-f0-9-]{36}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const processStartKeyPattern = /^[A-Za-z0-9:._-]{1,200}$/u;
const lockDatabaseName = ".forgex-verification-runner-locks.sqlite";

const parseDescriptor = (input: unknown): LockDescriptor => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Runner 单实例锁记录格式不正确");
  }
  const value = input as Record<string, unknown>;
  if (
    value.schemaVersion !== 1 ||
    value.state !== "active" ||
    typeof value.identityHash !== "string" ||
    !sha256Pattern.test(value.identityHash) ||
    typeof value.ownerToken !== "string" ||
    !uuidPattern.test(value.ownerToken) ||
    typeof value.processId !== "number" ||
    !Number.isSafeInteger(value.processId) ||
    value.processId < 1 ||
    typeof value.processStartKey !== "string" ||
    !processStartKeyPattern.test(value.processStartKey)
  ) {
    throw new Error("Runner 单实例锁记录格式不正确");
  }
  return value as unknown as LockDescriptor;
};

const descriptorFromRow = (row: unknown): LockDescriptor => {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error("Runner 单实例锁记录格式不正确");
  }
  const value = row as Record<string, unknown>;
  return parseDescriptor({
    schemaVersion: value.schema_version,
    state: value.state,
    identityHash: value.identity_hash,
    ownerToken: value.owner_token,
    processId: value.process_id,
    processStartKey: value.process_start_key,
  });
};

const sameDescriptor = (left: LockDescriptor, right: LockDescriptor): boolean =>
  left.identityHash === right.identityHash &&
  left.ownerToken === right.ownerToken &&
  left.processId === right.processId &&
  left.processStartKey === right.processStartKey;

type ProcessLookup =
  | { kind: "found"; startKey: string }
  | { kind: "missing" }
  | { kind: "unknown" };

const windowsProcessLookup = async (
  processId: number,
): Promise<ProcessLookup> => {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    return { kind: "unknown" };
  }
  const powershellPath = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = String.raw`
try {
  $process = [System.Diagnostics.Process]::GetProcessById([int]$env:FORGEX_LOCK_PID)
  [Console]::Out.Write($process.StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture))
  exit 0
} catch [System.ArgumentException] {
  exit 3
} catch {
  exit 4
}
`;
  try {
    const result = await execFileAsync(
      powershellPath,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      {
        encoding: "utf8",
        env: {
          SystemRoot: systemRoot,
          FORGEX_LOCK_PID: String(processId),
        },
        timeout: 10_000,
        windowsHide: true,
      },
    );
    const startKey = result.stdout.trim();
    return processStartKeyPattern.test(startKey)
      ? { kind: "found", startKey }
      : { kind: "unknown" };
  } catch (error) {
    return error instanceof Error &&
      (error as NodeJS.ErrnoException & { code?: number }).code === 3
      ? { kind: "missing" }
      : { kind: "unknown" };
  }
};

const linuxProcessLookup = async (
  processId: number,
): Promise<ProcessLookup> => {
  try {
    const [bootId, stat] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${processId}/stat`, "utf8"),
    ]);
    const afterCommand = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTime = afterCommand[19];
    const startKey = `${bootId.trim()}:${startTime ?? ""}`;
    return processStartKeyPattern.test(startKey)
      ? { kind: "found", startKey }
      : { kind: "unknown" };
  } catch (error) {
    return missingFile(error) ? { kind: "missing" } : { kind: "unknown" };
  }
};

const uncachedProcessLookup = async (
  processId: number,
): Promise<ProcessLookup> => {
  if (process.platform === "win32") return windowsProcessLookup(processId);
  if (process.platform === "linux") return linuxProcessLookup(processId);
  return { kind: "unknown" };
};

let currentProcessLookup: Promise<ProcessLookup> | null = null;

const lookupProcess = async (processId: number): Promise<ProcessLookup> => {
  if (processId !== process.pid) return uncachedProcessLookup(processId);
  currentProcessLookup ??= uncachedProcessLookup(processId);
  return currentProcessLookup;
};

const ownerStatus = async (
  descriptor: LockDescriptor,
): Promise<"alive" | "dead" | "unknown"> => {
  const lookup = await lookupProcess(descriptor.processId);
  if (lookup.kind === "unknown") return "unknown";
  if (lookup.kind === "missing") return "dead";
  return lookup.startKey === descriptor.processStartKey ? "alive" : "dead";
};

const withImmediateTransaction = <T>(
  database: DatabaseSync,
  operation: () => T,
): T => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // 原异常包含真正的失败原因；SQLite 会在连接关闭时回滚未提交事务。
    }
    throw error;
  }
};

interface LockStatements {
  find: StatementSync;
  insert: StatementSync;
  replaceDead: StatementSync;
  removeOwned: StatementSync;
}

const prepareStatements = (database: DatabaseSync): LockStatements => ({
  find: database.prepare(`
    SELECT
      schema_version,
      state,
      identity_hash,
      owner_token,
      process_id,
      process_start_key
    FROM runner_instance_locks
    WHERE identity_hash = ?
  `),
  insert: database.prepare(`
    INSERT INTO runner_instance_locks (
      schema_version,
      state,
      identity_hash,
      owner_token,
      process_id,
      process_start_key
    ) VALUES (1, 'active', ?, ?, ?, ?)
  `),
  replaceDead: database.prepare(`
    DELETE FROM runner_instance_locks
    WHERE identity_hash = ?
      AND owner_token = ?
      AND process_id = ?
      AND process_start_key = ?
  `),
  removeOwned: database.prepare(`
    DELETE FROM runner_instance_locks
    WHERE identity_hash = ?
      AND owner_token = ?
      AND process_id = ?
      AND process_start_key = ?
  `),
});

const openLockDatabase = async (
  privateDirectory: string,
): Promise<DatabaseSync> => {
  const databasePath = path.join(privateDirectory, lockDatabaseName);
  const database = new DatabaseSync(databasePath, {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  });
  try {
    database.exec("PRAGMA busy_timeout = 10000");
    database.exec(`
      CREATE TABLE IF NOT EXISTS runner_instance_locks (
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        state TEXT NOT NULL CHECK (state = 'active'),
        identity_hash TEXT PRIMARY KEY CHECK (
          length(identity_hash) = 64
          AND identity_hash NOT GLOB '*[^0-9a-f]*'
        ),
        owner_token TEXT NOT NULL UNIQUE CHECK (length(owner_token) = 36),
        process_id INTEGER NOT NULL CHECK (process_id > 0),
        process_start_key TEXT NOT NULL CHECK (
          length(process_start_key) BETWEEN 1 AND 200
        )
      ) STRICT
    `);
    if (process.platform !== "win32") await chmod(databasePath, 0o600);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};

const insertDescriptor = (
  statements: LockStatements,
  descriptor: LockDescriptor,
): void => {
  statements.insert.run(
    descriptor.identityHash,
    descriptor.ownerToken,
    descriptor.processId,
    descriptor.processStartKey,
  );
};

export class VerificationRunnerInstanceLock {
  readonly #database: DatabaseSync;
  readonly #statements: LockStatements;
  readonly #descriptor: LockDescriptor;
  #released = false;

  private constructor(
    database: DatabaseSync,
    statements: LockStatements,
    descriptor: LockDescriptor,
  ) {
    this.#database = database;
    this.#statements = statements;
    this.#descriptor = descriptor;
  }

  static async acquire(
    identity: string,
    privateDirectory: string,
  ): Promise<VerificationRunnerInstanceLock> {
    if (!path.isAbsolute(privateDirectory)) {
      throw new Error("Runner 单实例锁必须位于受保护的绝对目录");
    }
    const identityHash = createHash("sha256")
      .update(identity, "utf8")
      .digest("hex");
    const currentProcess = await lookupProcess(process.pid);
    if (currentProcess.kind !== "found") {
      throw new Error("Runner 无法取得当前控制器进程的可信启动标识");
    }
    const descriptor: LockDescriptor = {
      schemaVersion: 1,
      state: "active",
      identityHash,
      ownerToken: randomUUID(),
      processId: process.pid,
      processStartKey: currentProcess.startKey,
    };
    const database = await openLockDatabase(privateDirectory);
    const statements = prepareStatements(database);
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const existing = withImmediateTransaction(database, () => {
          const row = statements.find.get(identityHash);
          if (row) return descriptorFromRow(row);
          insertDescriptor(statements, descriptor);
          return null;
        });
        if (!existing) {
          return new VerificationRunnerInstanceLock(
            database,
            statements,
            descriptor,
          );
        }

        const status = await ownerStatus(existing);
        if (status === "alive") {
          throw new Error("同一验证日志对应的 Runner 进程已经运行");
        }
        if (status === "unknown") {
          throw new Error("Runner 无法证明旧锁进程已经退出，拒绝抢占");
        }

        const replaced = withImmediateTransaction(database, () => {
          const removed = statements.replaceDead.run(
            existing.identityHash,
            existing.ownerToken,
            existing.processId,
            existing.processStartKey,
          );
          if (removed.changes !== 1) return false;
          insertDescriptor(statements, descriptor);
          return true;
        });
        if (replaced) {
          return new VerificationRunnerInstanceLock(
            database,
            statements,
            descriptor,
          );
        }
      }
      throw new Error("Runner 无法取得验证日志的单实例执行锁");
    } catch (error) {
      database.close();
      throw error;
    }
  }

  assertHeld(): void {
    if (this.#released) throw new Error("Runner 单实例锁已经失效");
    const row = this.#statements.find.get(this.#descriptor.identityHash);
    if (!row || !sameDescriptor(descriptorFromRow(row), this.#descriptor)) {
      throw new Error("Runner 单实例锁已经不再属于当前进程");
    }
  }

  async release(): Promise<void> {
    if (this.#released) return;
    withImmediateTransaction(this.#database, () => {
      const removed = this.#statements.removeOwned.run(
        this.#descriptor.identityHash,
        this.#descriptor.ownerToken,
        this.#descriptor.processId,
        this.#descriptor.processStartKey,
      );
      if (removed.changes !== 1) {
        throw new Error("Runner 单实例锁已经不再属于当前进程");
      }
    });
    this.#released = true;
    this.#database.close();
  }
}
