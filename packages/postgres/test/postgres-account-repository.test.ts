import { describe, expect, it } from "vitest";

import { PostgresAccountRepository } from "../src/index.js";
import type { PostgresAccountPool } from "../src/postgres-account-repository.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";

describe("PostgreSQL 平台账号仓储", () => {
  it("只保存带随机盐的密码摘要，并使用摘要完成认证", async () => {
    const insertedRows: Record<string, unknown>[] = [];
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool: PostgresAccountPool = {
      query: async (text, values = []) => {
        queries.push({ text, values });
        if (text.startsWith("INSERT INTO forgex_platform_accounts")) {
          const stored = {
            account_key: values[0],
            tenant_key: values[1],
            username: values[2],
            actor_name: values[3],
            roles: values[4],
            password_salt: values[5],
            password_hash: values[6],
            enabled: true,
            revision: 1,
          };
          insertedRows.splice(0, insertedRows.length, stored);
          return { rows: [stored] };
        }
        if (text.startsWith("SELECT account_key")) {
          return { rows: insertedRows };
        }
        throw new Error(`未预期的 SQL: ${text}`);
      },
    };
    const repository = new PostgresAccountRepository(pool);

    const created = await repository.create(tenantKey, {
      username: "security.admin",
      actorName: "安全管理员",
      roles: ["administrator"],
      password: "123456",
    });

    expect(created).toMatchObject({
      username: "security.admin",
      actorName: "安全管理员",
      enabled: true,
    });
    const stored = insertedRows[0];
    expect(stored).toBeDefined();
    expect(stored?.password_salt).toBeInstanceOf(Buffer);
    expect(stored?.password_hash).toBeInstanceOf(Buffer);
    expect((stored?.password_salt as Buffer).byteLength).toBe(16);
    expect((stored?.password_hash as Buffer).byteLength).toBe(32);
    expect(JSON.stringify(stored)).not.toContain("123456");
    expect(JSON.stringify(queries)).not.toContain("123456");

    await expect(
      repository.authenticate("security.admin", "123456"),
    ).resolves.toMatchObject({
      actorName: "安全管理员",
      username: "security.admin",
      roles: ["administrator"],
    });
    await expect(
      repository.authenticate("security.admin", "Incorrect-Password!"),
    ).resolves.toBeNull();
  });

  it("把注入形态的密码作为普通数据校验，不拼接进 SQL", async () => {
    const rawPassword = "' OR 1=1 --";
    const sqlTexts: string[] = [];
    const rows: Record<string, unknown>[] = [];
    const pool: PostgresAccountPool = {
      query: async (text, values = []) => {
        sqlTexts.push(text);
        if (text.startsWith("INSERT INTO forgex_platform_accounts")) {
          const stored = {
            account_key: values[0],
            tenant_key: values[1],
            username: values[2],
            actor_name: values[3],
            roles: values[4],
            password_salt: values[5],
            password_hash: values[6],
            enabled: true,
            revision: 1,
          };
          rows.splice(0, rows.length, stored);
          return { rows: [stored] };
        }
        if (text.startsWith("SELECT account_key")) return { rows };
        throw new Error(`未预期的 SQL: ${text}`);
      },
    };
    const repository = new PostgresAccountRepository(pool);

    await repository.create(tenantKey, {
      username: "injection.password",
      actorName: "注入防护账号",
      roles: ["developer"],
      password: rawPassword,
    });

    await expect(
      repository.authenticate("injection.password", rawPassword),
    ).resolves.toMatchObject({ username: "injection.password" });
    expect(sqlTexts.join("\n")).not.toContain(rawPassword);
  });

  it("初始化账号名被其他租户占用时明确失败", async () => {
    const duplicate = Object.assign(new Error("duplicate"), { code: "23505" });
    const pool: PostgresAccountPool = {
      query: async (text) => {
        if (text.startsWith("INSERT INTO forgex_platform_accounts")) {
          throw duplicate;
        }
        if (text.startsWith("SELECT 1 FROM forgex_platform_accounts")) {
          return { rows: [] };
        }
        throw new Error(`未预期的 SQL: ${text}`);
      },
    };

    await expect(
      new PostgresAccountRepository(pool).ensureBootstrapAdministrator({
        tenantKey,
        username: "super.admin",
        actorName: "超级管理员",
        password: "Bootstrap-Password-2026!",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "account_conflict",
    });
  });
});
