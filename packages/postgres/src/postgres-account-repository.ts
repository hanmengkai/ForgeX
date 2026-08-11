import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

import {
  ApplicationError,
  type AccountCreateInput,
  type AccountDeleteInput,
  type AccountRepository,
  type AccountUpdateInput,
  type AuthenticatedPrincipal,
  type PlatformAccount,
  type PlatformRole,
} from "@forgex/application";
import { z } from "zod";

import type { PostgresQueryResult } from "./postgres-worker-fleet-repository.js";

export interface PostgresAccountPool {
  query(text: string, values?: unknown[]): Promise<PostgresQueryResult>;
}

const scrypt = promisify(scryptCallback);
const platformRoleSchema = z.enum([
  "product_owner",
  "requirement_analyst",
  "developer",
  "administrator",
]);
const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u);
const passwordSchema = z.string().min(12).max(128);
const missingAccountSalt = Buffer.alloc(16, 0xa5);
const accountRowSchema = z
  .object({
    account_key: z.string().uuid(),
    tenant_key: z.string().uuid(),
    username: usernameSchema,
    actor_name: z.string().trim().min(2).max(100),
    roles: z.array(platformRoleSchema).min(1).max(4),
    enabled: z.boolean(),
    revision: z.coerce.number().int().positive(),
  })
  .passthrough();

const accountFrom = (row: unknown): PlatformAccount => {
  const parsed = accountRowSchema.parse(row);
  return {
    accountKey: parsed.account_key.toLowerCase(),
    tenantKey: parsed.tenant_key.toLowerCase(),
    username: parsed.username,
    actorName: parsed.actor_name,
    roles: [...new Set(parsed.roles)] as PlatformRole[],
    enabled: parsed.enabled,
    revision: parsed.revision,
  };
};

const hashPassword = async (
  password: string,
  salt: Uint8Array = randomBytes(16),
): Promise<{ salt: Buffer; hash: Buffer }> => ({
  salt: Buffer.from(salt),
  hash: (await scrypt(passwordSchema.parse(password), salt, 32)) as Buffer,
});

const postgresCode = (error: unknown): string | null =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;

export class PostgresAccountRepository implements AccountRepository {
  constructor(readonly pool: PostgresAccountPool) {}

  async authenticate(
    username: string,
    password: string,
  ): Promise<AuthenticatedPrincipal | null> {
    const normalized = usernameSchema.safeParse(username);
    const candidatePassword = passwordSchema.safeParse(password);
    if (!normalized.success || !candidatePassword.success) return null;
    const result = await this.pool.query(
      "SELECT account_key, tenant_key, username, actor_name, roles, enabled, revision, password_salt, password_hash FROM forgex_platform_accounts WHERE username = $1 LIMIT 1",
      [normalized.data],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    const passwordSalt = row?.password_salt;
    const passwordHash = row?.password_hash;
    const candidate = await hashPassword(
      candidatePassword.data,
      Buffer.isBuffer(passwordSalt) ? passwordSalt : missingAccountSalt,
    );
    if (!row) return null;
    if (!Buffer.isBuffer(passwordSalt) || !Buffer.isBuffer(passwordHash)) {
      throw new Error("平台账号密码摘要格式不正确");
    }
    const account = accountFrom(row);
    if (
      candidate.hash.length !== passwordHash.length ||
      !timingSafeEqual(
        new Uint8Array(candidate.hash),
        new Uint8Array(passwordHash),
      )
    ) {
      return null;
    }
    if (!account.enabled) return null;
    return {
      actorKey: account.accountKey,
      actorName: account.actorName,
      username: account.username,
      tenantKey: account.tenantKey,
      roles: account.roles,
    };
  }

  async list(tenantKey: string): Promise<PlatformAccount[]> {
    const result = await this.pool.query(
      "SELECT account_key, tenant_key, username, actor_name, roles, enabled, revision FROM forgex_platform_accounts WHERE tenant_key = $1 ORDER BY username",
      [tenantKey],
    );
    return result.rows.map(accountFrom);
  }

  async create(
    tenantKey: string,
    input: AccountCreateInput,
  ): Promise<PlatformAccount> {
    const password = await hashPassword(input.password);
    try {
      const result = await this.pool.query(
        "INSERT INTO forgex_platform_accounts (account_key, tenant_key, username, actor_name, roles, password_salt, password_hash) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING account_key, tenant_key, username, actor_name, roles, enabled, revision",
        [
          randomUUID(),
          tenantKey,
          usernameSchema.parse(input.username),
          input.actorName,
          [...new Set(input.roles)],
          password.salt,
          password.hash,
        ],
      );
      return accountFrom(result.rows[0]);
    } catch (error) {
      if (postgresCode(error) === "23505") {
        throw new ApplicationError(409, "account_conflict", "这个账号已经存在");
      }
      throw error;
    }
  }

  async update(
    tenantKey: string,
    accountKey: string,
    input: AccountUpdateInput,
  ): Promise<PlatformAccount> {
    const password = input.password ? await hashPassword(input.password) : null;
    const result = password
      ? await this.pool.query(
          "UPDATE forgex_platform_accounts SET actor_name = $4, roles = $5, enabled = $6, password_salt = $7, password_hash = $8, revision = revision + 1, updated_at = now() WHERE tenant_key = $1 AND account_key = $2 AND revision = $3 RETURNING account_key, tenant_key, username, actor_name, roles, enabled, revision",
          [
            tenantKey,
            accountKey,
            input.expectedRevision,
            input.actorName,
            input.roles,
            input.enabled,
            password.salt,
            password.hash,
          ],
        )
      : await this.pool.query(
          "UPDATE forgex_platform_accounts SET actor_name = $4, roles = $5, enabled = $6, revision = revision + 1, updated_at = now() WHERE tenant_key = $1 AND account_key = $2 AND revision = $3 RETURNING account_key, tenant_key, username, actor_name, roles, enabled, revision",
          [
            tenantKey,
            accountKey,
            input.expectedRevision,
            input.actorName,
            input.roles,
            input.enabled,
          ],
        );
    return this.requireChanged(result, tenantKey, accountKey);
  }

  async delete(
    tenantKey: string,
    accountKey: string,
    input: AccountDeleteInput,
  ): Promise<void> {
    const result = await this.pool.query(
      "DELETE FROM forgex_platform_accounts WHERE tenant_key = $1 AND account_key = $2 AND revision = $3 RETURNING account_key",
      [tenantKey, accountKey, input.expectedRevision],
    );
    if (result.rows.length === 1) return;
    await this.throwMissingOrConflict(tenantKey, accountKey);
  }

  async ensureBootstrapAdministrator(input: {
    tenantKey: string;
    username: string;
    actorName: string;
    password: string;
  }): Promise<void> {
    const password = await hashPassword(input.password);
    try {
      await this.pool.query(
        "INSERT INTO forgex_platform_accounts (account_key, tenant_key, username, actor_name, roles, password_salt, password_hash) SELECT $1, $2, $3, $4, ARRAY['administrator']::text[], $5, $6 WHERE NOT EXISTS (SELECT 1 FROM forgex_platform_accounts WHERE tenant_key = $2)",
        [
          randomUUID(),
          input.tenantKey,
          usernameSchema.parse(input.username),
          input.actorName,
          password.salt,
          password.hash,
        ],
      );
    } catch (error) {
      if (postgresCode(error) !== "23505") throw error;
      const existingTenant = await this.pool.query(
        "SELECT 1 FROM forgex_platform_accounts WHERE tenant_key = $1 LIMIT 1",
        [input.tenantKey],
      );
      if (existingTenant.rows.length === 0) {
        throw new ApplicationError(
          409,
          "account_conflict",
          "初始化超级管理员账号已经被其他租户使用",
        );
      }
    }
  }

  private async requireChanged(
    result: PostgresQueryResult,
    tenantKey: string,
    accountKey: string,
  ): Promise<PlatformAccount> {
    if (result.rows.length === 1) return accountFrom(result.rows[0]);
    return this.throwMissingOrConflict(tenantKey, accountKey);
  }

  private async throwMissingOrConflict(
    tenantKey: string,
    accountKey: string,
  ): Promise<never> {
    const existing = await this.pool.query(
      "SELECT 1 FROM forgex_platform_accounts WHERE tenant_key = $1 AND account_key = $2",
      [tenantKey, accountKey],
    );
    if (existing.rows.length === 0) {
      throw new ApplicationError(404, "account_not_found", "没有找到这个账号");
    }
    throw new ApplicationError(
      409,
      "account_revision_conflict",
      "账号信息已经更新，请刷新后重试",
    );
  }
}
