import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { AuthenticatedPrincipal, PlatformRole } from "./auth.js";
import { ApplicationError } from "./errors.js";

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
const accountKeySchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const tenantKeySchema = accountKeySchema;

export interface PlatformAccount {
  accountKey: string;
  tenantKey: string;
  username: string;
  actorName: string;
  roles: PlatformRole[];
  enabled: boolean;
  revision: number;
}

export interface AccountCreateInput {
  username: string;
  actorName: string;
  roles: PlatformRole[];
  password: string;
}

export interface AccountUpdateInput {
  expectedRevision: number;
  actorName: string;
  roles: PlatformRole[];
  enabled: boolean;
  password?: string | undefined;
}

export interface AccountDeleteInput {
  expectedRevision: number;
}

export interface AccountRepository {
  authenticate(
    username: string,
    password: string,
  ): Promise<AuthenticatedPrincipal | null>;
  list(tenantKey: string): Promise<PlatformAccount[]>;
  create(
    tenantKey: string,
    input: AccountCreateInput,
  ): Promise<PlatformAccount>;
  update(
    tenantKey: string,
    accountKey: string,
    input: AccountUpdateInput,
  ): Promise<PlatformAccount>;
  delete(
    tenantKey: string,
    accountKey: string,
    input: AccountDeleteInput,
  ): Promise<void>;
}

interface InMemoryAccountSeed extends PlatformAccount {
  password: string;
}

const cloneAccount = (account: PlatformAccount): PlatformAccount => ({
  ...account,
  roles: [...account.roles],
});

const accountSchema = z
  .object({
    accountKey: accountKeySchema,
    tenantKey: tenantKeySchema,
    username: usernameSchema,
    actorName: z.string().trim().min(2).max(100),
    roles: z.array(platformRoleSchema).min(1).max(4),
    enabled: z.boolean(),
    revision: z.number().int().positive(),
  })
  .strict()
  .transform((account) => ({
    ...account,
    roles: [...new Set(account.roles)] as PlatformRole[],
  }));

const createInputSchema = z
  .object({
    username: usernameSchema,
    actorName: z.string().trim().min(2).max(100),
    roles: z.array(platformRoleSchema).min(1).max(4),
    password: passwordSchema,
  })
  .strict()
  .transform((input) => ({
    ...input,
    roles: [...new Set(input.roles)] as PlatformRole[],
  }));

const updateInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    actorName: z.string().trim().min(2).max(100),
    roles: z.array(platformRoleSchema).min(1).max(4),
    enabled: z.boolean(),
    password: passwordSchema.optional(),
  })
  .strict()
  .transform((input) => ({
    ...input,
    roles: [...new Set(input.roles)] as PlatformRole[],
  }));

export class InMemoryAccountRepository implements AccountRepository {
  readonly #accounts = new Map<string, InMemoryAccountSeed>();

  constructor(seeds: readonly InMemoryAccountSeed[] = []) {
    for (const seed of seeds) {
      const { password: seedPassword, ...visibleSeed } = seed;
      const account = accountSchema.parse(visibleSeed);
      const password = passwordSchema.parse(seedPassword);
      if (
        [...this.#accounts.values()].some(
          (candidate) => candidate.username === account.username,
        )
      ) {
        throw new Error("平台账号不能重复");
      }
      this.#accounts.set(account.accountKey, { ...account, password });
    }
  }

  async authenticate(
    username: string,
    password: string,
  ): Promise<AuthenticatedPrincipal | null> {
    const normalized = usernameSchema.safeParse(username);
    if (!normalized.success || !passwordSchema.safeParse(password).success) {
      return null;
    }
    const account = [...this.#accounts.values()].find(
      (candidate) => candidate.username === normalized.data,
    );
    if (!account || !account.enabled || account.password !== password) {
      return null;
    }
    return {
      actorKey: account.accountKey,
      actorName: account.actorName,
      username: account.username,
      tenantKey: account.tenantKey,
      roles: [...account.roles],
    };
  }

  async list(tenantKey: string): Promise<PlatformAccount[]> {
    const tenant = tenantKeySchema.parse(tenantKey);
    return [...this.#accounts.values()]
      .filter((account) => account.tenantKey === tenant)
      .map(({ password: _password, ...account }) => cloneAccount(account))
      .sort((left, right) => left.username.localeCompare(right.username));
  }

  async create(
    tenantKey: string,
    input: AccountCreateInput,
  ): Promise<PlatformAccount> {
    const tenant = tenantKeySchema.parse(tenantKey);
    const parsed = createInputSchema.parse(input);
    if (
      [...this.#accounts.values()].some(
        (account) => account.username === parsed.username,
      )
    ) {
      throw new ApplicationError(409, "account_conflict", "这个账号已经存在");
    }
    const account: InMemoryAccountSeed = {
      accountKey: randomUUID(),
      tenantKey: tenant,
      username: parsed.username,
      actorName: parsed.actorName,
      roles: parsed.roles,
      enabled: true,
      revision: 1,
      password: parsed.password,
    };
    this.#accounts.set(account.accountKey, account);
    const { password: _password, ...visible } = account;
    return cloneAccount(visible);
  }

  async update(
    tenantKey: string,
    accountKey: string,
    input: AccountUpdateInput,
  ): Promise<PlatformAccount> {
    const tenant = tenantKeySchema.parse(tenantKey);
    const key = accountKeySchema.parse(accountKey);
    const parsed = updateInputSchema.parse(input);
    const current = this.#accounts.get(key);
    if (!current || current.tenantKey !== tenant) {
      throw new ApplicationError(404, "account_not_found", "没有找到这个账号");
    }
    if (current.revision !== parsed.expectedRevision) {
      throw new ApplicationError(
        409,
        "account_revision_conflict",
        "账号信息已经更新，请刷新后重试",
      );
    }
    const updated: InMemoryAccountSeed = {
      ...current,
      actorName: parsed.actorName,
      roles: parsed.roles,
      enabled: parsed.enabled,
      revision: current.revision + 1,
      password: parsed.password ?? current.password,
    };
    this.#accounts.set(key, updated);
    const { password: _password, ...visible } = updated;
    return cloneAccount(visible);
  }

  async delete(
    tenantKey: string,
    accountKey: string,
    input: AccountDeleteInput,
  ): Promise<void> {
    const tenant = tenantKeySchema.parse(tenantKey);
    const key = accountKeySchema.parse(accountKey);
    const current = this.#accounts.get(key);
    if (!current || current.tenantKey !== tenant) {
      throw new ApplicationError(404, "account_not_found", "没有找到这个账号");
    }
    if (current.revision !== input.expectedRevision) {
      throw new ApplicationError(
        409,
        "account_revision_conflict",
        "账号信息已经更新，请刷新后重试",
      );
    }
    this.#accounts.delete(key);
  }
}

const requireAdministrator = (principal: AuthenticatedPrincipal): void => {
  if (!principal.roles.includes("administrator")) {
    throw new ApplicationError(
      403,
      "account_admin_required",
      "只有超级管理员可以管理平台账号",
    );
  }
};

const remainsWithAdministrator = (
  accounts: readonly PlatformAccount[],
  accountKey: string,
  replacement: Pick<PlatformAccount, "enabled" | "roles"> | null,
): boolean =>
  accounts.some((account) => {
    if (account.accountKey !== accountKey) {
      return account.enabled && account.roles.includes("administrator");
    }
    return (
      replacement !== null &&
      replacement.enabled &&
      replacement.roles.includes("administrator")
    );
  });

export class AccountAdministrationService {
  constructor(readonly repository: AccountRepository) {}

  async authenticate(input: {
    username: string;
    password: string;
  }): Promise<AuthenticatedPrincipal | null> {
    const parsed = z
      .object({ username: usernameSchema, password: passwordSchema })
      .strict()
      .safeParse(input);
    if (!parsed.success) return null;
    return this.repository.authenticate(
      parsed.data.username,
      parsed.data.password,
    );
  }

  async list(principal: AuthenticatedPrincipal): Promise<PlatformAccount[]> {
    requireAdministrator(principal);
    return this.repository.list(principal.tenantKey);
  }

  async create(
    principal: AuthenticatedPrincipal,
    input: AccountCreateInput,
  ): Promise<PlatformAccount> {
    requireAdministrator(principal);
    return this.repository.create(
      principal.tenantKey,
      createInputSchema.parse(input),
    );
  }

  async update(
    principal: AuthenticatedPrincipal,
    accountKey: string,
    input: AccountUpdateInput,
  ): Promise<PlatformAccount> {
    requireAdministrator(principal);
    const key = accountKeySchema.parse(accountKey);
    const parsed = updateInputSchema.parse(input);
    const accounts = await this.repository.list(principal.tenantKey);
    const current = accounts.find((account) => account.accountKey === key);
    if (!current) {
      throw new ApplicationError(404, "account_not_found", "没有找到这个账号");
    }
    if (
      current.enabled &&
      current.roles.includes("administrator") &&
      !remainsWithAdministrator(accounts, key, parsed)
    ) {
      throw new ApplicationError(
        409,
        "last_administrator",
        "至少保留一个可用的超级管理员账号",
      );
    }
    return this.repository.update(principal.tenantKey, key, parsed);
  }

  async delete(
    principal: AuthenticatedPrincipal,
    accountKey: string,
    input: AccountDeleteInput,
  ): Promise<void> {
    requireAdministrator(principal);
    const key = accountKeySchema.parse(accountKey);
    const parsed = z
      .object({ expectedRevision: z.number().int().positive() })
      .strict()
      .parse(input);
    const accounts = await this.repository.list(principal.tenantKey);
    const current = accounts.find((account) => account.accountKey === key);
    if (!current) {
      throw new ApplicationError(404, "account_not_found", "没有找到这个账号");
    }
    if (
      current.enabled &&
      current.roles.includes("administrator") &&
      !remainsWithAdministrator(accounts, key, null)
    ) {
      throw new ApplicationError(
        409,
        "last_administrator",
        "至少保留一个可用的超级管理员账号",
      );
    }
    await this.repository.delete(principal.tenantKey, key, parsed);
  }
}
