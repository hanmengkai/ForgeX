import { fileURLToPath, pathToFileURL } from "node:url";

import { Pool } from "pg";

import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "./migration-runner.js";

const requireDatabaseUrl = (): string => {
  const value = process.env.FORGEX_DATABASE_URL;
  if (!value) throw new Error("缺少 FORGEX_DATABASE_URL");
  try {
    const protocol = new URL(value).protocol;
    if (!["postgres:", "postgresql:"].includes(protocol)) {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error("FORGEX_DATABASE_URL 不是有效的 PostgreSQL 地址");
  }
  return value;
};

export const migratePostgres = async (): Promise<void> => {
  const migrationsDirectory =
    process.env.FORGEX_MIGRATIONS_DIR ??
    fileURLToPath(new URL("../migrations/", import.meta.url));
  const migrations = await loadPostgresMigrations(migrationsDirectory);
  const pool = new Pool({
    connectionString: requireDatabaseUrl(),
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  try {
    await runPostgresMigrations(pool, migrations);
  } finally {
    await pool.end();
  }
};

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  void migratePostgres().catch(() => {
    console.error("ForgeX PostgreSQL 迁移失败，请检查数据库连接与迁移历史");
    process.exitCode = 1;
  });
}
