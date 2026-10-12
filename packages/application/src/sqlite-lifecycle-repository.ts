import { DatabaseSync } from "node:sqlite";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  emptyLifecycleStore,
  LifecycleStoreSchema,
  type LifecycleRepository,
  type LifecycleStore,
} from "./lifecycle-service.js";

// 本地样板使用 SQLite 原子事务；正式多实例控制面继续使用 PostgreSQL 仓储。
export class SqliteLifecycleRepository implements LifecycleRepository {
  #closed = false;
  #tail: Promise<void> = Promise.resolve();
  private constructor(readonly database: DatabaseSync) {}
  static async open(file: string): Promise<SqliteLifecycleRepository> {
    const database = await openPrivateSqlite(file);
    try {
      database.exec(
        "CREATE TABLE IF NOT EXISTS lifecycle_states(tenant_key TEXT PRIMARY KEY, schema_version INTEGER NOT NULL CHECK(schema_version=2), state TEXT NOT NULL);",
      );
      return new SqliteLifecycleRepository(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }
  async transaction<T>(
    tenantKey: string,
    operation: (state: LifecycleStore) => Promise<T> | T,
  ): Promise<T> {
    z.string().uuid().parse(tenantKey);
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((r) => {
      release = r;
    });
    await previous;
    try {
      if (this.#closed) throw new Error("持久化控制面已关闭");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const row = this.database
          .prepare("SELECT state FROM lifecycle_states WHERE tenant_key=?")
          .get(tenantKey);
        const state = row
          ? LifecycleStoreSchema.parse(JSON.parse(String(row.state)))
          : emptyLifecycleStore();
        const result = await operation(state);
        this.database
          .prepare(
            "INSERT INTO lifecycle_states VALUES (?,2,?) ON CONFLICT(tenant_key) DO UPDATE SET state=excluded.state",
          )
          .run(tenantKey, JSON.stringify(LifecycleStoreSchema.parse(state)));
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      release();
    }
  }
  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.database.close();
    }
  }
}

export async function openPrivateSqlite(file: string): Promise<DatabaseSync> {
  if (!path.isAbsolute(file)) throw new Error("持久化状态必须使用绝对私有路径");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if ((await realpath(path.dirname(file))) !== path.dirname(file))
    throw new Error("私有状态路径不能包含符号链接");
  const directory = await lstat(path.dirname(file));
  if (
    process.platform !== "win32" &&
    (directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0)
  )
    throw new Error("控制面状态必须保存在当前用户的私有目录中");
  try {
    const handle = await open(file, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
  )
    throw new Error("控制面状态必须保存在当前用户的私有文件中");
  const database = new DatabaseSync(file);
  try {
    database.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;",
    );
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
