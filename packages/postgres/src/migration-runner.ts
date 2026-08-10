import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  PostgresPool,
  PostgresQueryResult,
} from "./postgres-worker-fleet-repository.js";

export interface PostgresMigration {
  version: string;
  name: string;
  sql: string;
}

const migrationVersionPattern = /^\d{4}$/u;
const migrationNamePattern = /^[a-z0-9][a-z0-9_]{0,99}$/u;
const migrationFilePattern = /^(\d{4})_([a-z0-9][a-z0-9_]{0,99})\.sql$/u;
const checksumPattern = /^[a-f0-9]{64}$/u;

const checksum = (sql: string): string =>
  createHash("sha256").update(sql, "utf8").digest("hex");

const validateMigrations = (
  migrations: readonly PostgresMigration[],
): PostgresMigration[] => {
  const validated = migrations.map((migration) => {
    if (!migrationVersionPattern.test(migration.version)) {
      throw new Error("PostgreSQL 迁移版本必须是四位数字");
    }
    if (!migrationNamePattern.test(migration.name)) {
      throw new Error("PostgreSQL 迁移名称格式不正确");
    }
    if (!migration.sql.trim()) {
      throw new Error("PostgreSQL 迁移内容不能为空");
    }
    return { ...migration };
  });
  for (let index = 1; index < validated.length; index += 1) {
    if (validated[index - 1]!.version >= validated[index]!.version) {
      throw new Error("PostgreSQL 迁移版本必须严格递增且不能重复");
    }
  }
  return validated;
};

const appliedMigrations = (
  result: PostgresQueryResult,
): Map<string, { name: string; checksum: string }> => {
  const applied = new Map<string, { name: string; checksum: string }>();
  for (const row of result.rows) {
    if (
      typeof row !== "object" ||
      row === null ||
      !("version" in row) ||
      !("name" in row) ||
      !("checksum" in row)
    ) {
      throw new Error("数据库迁移登记表包含无效记录");
    }
    const version = String(row.version);
    const name = String(row.name);
    const storedChecksum = String(row.checksum);
    if (
      !migrationVersionPattern.test(version) ||
      !migrationNamePattern.test(name) ||
      !checksumPattern.test(storedChecksum) ||
      applied.has(version)
    ) {
      throw new Error("数据库迁移登记表包含冲突记录");
    }
    applied.set(version, { name, checksum: storedChecksum });
  }
  return applied;
};

export const loadPostgresMigrations = async (
  directory: string,
): Promise<PostgresMigration[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations: PostgresMigration[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = migrationFilePattern.exec(entry.name);
    if (!match) {
      if (entry.name.endsWith(".sql")) {
        throw new Error(`无法识别 PostgreSQL 迁移文件：${entry.name}`);
      }
      continue;
    }
    migrations.push({
      version: match[1]!,
      name: match[2]!,
      sql: await readFile(path.join(directory, entry.name), "utf8"),
    });
  }
  migrations.sort((left, right) => left.version.localeCompare(right.version));
  return validateMigrations(migrations);
};

export const runPostgresMigrations = async (
  pool: PostgresPool,
  migrationsInput: readonly PostgresMigration[],
): Promise<void> => {
  const migrations = validateMigrations(migrationsInput);
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('forgex-schema-migrations', 0))",
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS forgex_schema_migrations (version text PRIMARY KEY CHECK (version ~ '^[0-9]{4}$'), name text NOT NULL, checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'), applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const applied = appliedMigrations(
      await client.query(
        "SELECT version, name, checksum FROM forgex_schema_migrations ORDER BY version",
      ),
    );
    for (const migration of migrations) {
      const migrationChecksum = checksum(migration.sql);
      const stored = applied.get(migration.version);
      if (stored) {
        if (
          stored.name !== migration.name ||
          stored.checksum !== migrationChecksum
        ) {
          throw new Error(
            `PostgreSQL 迁移 ${migration.version} 的摘要不一致，禁止改写已执行迁移`,
          );
        }
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO forgex_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
        [migration.version, migration.name, migrationChecksum],
      );
    }
    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // 保留原始迁移失败，连接释放后由运维重新检查数据库状态。
      }
    }
    throw error;
  } finally {
    client.release();
  }
};

export const assertPostgresMigrationsCurrent = async (
  pool: PostgresPool,
  migrationsInput: readonly PostgresMigration[],
): Promise<void> => {
  const migrations = validateMigrations(migrationsInput);
  const client = await pool.connect();
  try {
    const applied = appliedMigrations(
      await client.query(
        "SELECT version, name, checksum FROM forgex_schema_migrations ORDER BY version",
      ),
    );
    if (applied.size !== migrations.length) {
      throw new Error("PostgreSQL 迁移状态与当前程序不一致");
    }
    for (const migration of migrations) {
      const stored = applied.get(migration.version);
      if (
        !stored ||
        stored.name !== migration.name ||
        stored.checksum !== checksum(migration.sql)
      ) {
        throw new Error("PostgreSQL 迁移状态与当前程序不一致");
      }
    }
  } catch {
    throw new Error("PostgreSQL 迁移状态与当前程序不一致");
  } finally {
    client.release();
  }
};
