import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  AuthenticatedRunnerSchema,
  type AuthenticatedPrincipal,
  type AuthenticatedRunner,
  type PlatformRole,
  type RunnerSessionAuthenticator,
  type SessionAuthenticator,
} from "@forgex/application";
import { z } from "zod";

const internalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const publicKeyBase64 = z.string().min(40).max(1_000);
const platformRole = z.enum([
  "product_owner",
  "requirement_analyst",
  "developer",
  "administrator",
]);
const principalSchema = z
  .object({
    actorKey: internalKey,
    actorName: z.string().trim().min(2).max(100),
    tenantKey: internalKey,
    roles: z.array(platformRole).min(1).max(4),
  })
  .strict()
  .transform((principal) => ({
    ...principal,
    roles: [...new Set(principal.roles)] as PlatformRole[],
  }));
const runnerScopeSchema = z
  .object({
    tenantKey: internalKey,
    projectKey: internalKey,
    repositoryKey: internalKey,
  })
  .strict();
const evaluatorScopeSchema = z
  .object({ tenantKey: internalKey, projectKey: internalKey })
  .strict();

export const ControlPlaneRuntimeConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[A-Za-z0-9:.-]+$/u),
    port: z.number().int().min(1).max(65_535),
    sessionCookieSecure: z.boolean().default(true),
    sessionCookieMaxAgeSeconds: z
      .number()
      .int()
      .min(60)
      .max(30 * 24 * 60 * 60)
      .default(8 * 60 * 60),
    projectKey: internalKey,
    repositoryKey: internalKey,
    sessions: z
      .array(
        z.object({ tokenSha256: sha256, principal: principalSchema }).strict(),
      )
      .min(1)
      .max(500),
    runnerSessions: z
      .array(
        z
          .object({
            tokenSha256: sha256,
            runner: AuthenticatedRunnerSchema,
          })
          .strict(),
      )
      .max(100),
    trustedRunners: z
      .array(
        z
          .object({
            runnerKey: internalKey,
            keyId: internalKey,
            runnerName: z.string().trim().min(2).max(100),
            publicKeyBase64,
            scopes: z.array(runnerScopeSchema).min(1).max(100),
            acceptNewEvidence: z.boolean().default(true),
          })
          .strict(),
      )
      .max(100),
    skillEvaluators: z
      .array(
        z
          .object({
            evaluatorKey: internalKey,
            keyId: internalKey,
            evaluatorName: z.string().trim().min(2).max(100),
            publicKeyBase64,
            scopes: z.array(evaluatorScopeSchema).min(1).max(100),
            acceptNewEvaluations: z.boolean().default(true),
          })
          .strict(),
      )
      .max(100),
    mcpVerifiers: z
      .array(
        z
          .object({
            verifierKey: internalKey,
            keyId: internalKey,
            verifierName: z.string().trim().min(2).max(100),
            publicKeyBase64,
            scopes: z.array(evaluatorScopeSchema).min(1).max(100),
            acceptNewAttestations: z.boolean().default(true),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export type ControlPlaneRuntimeConfig = z.infer<
  typeof ControlPlaneRuntimeConfigSchema
>;

export const loadControlPlaneRuntimeConfig = async (
  path: string,
): Promise<ControlPlaneRuntimeConfig> => {
  let input: unknown;
  try {
    input = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("Control Plane 运行配置无法读取或不是有效 JSON");
  }
  const parsed = ControlPlaneRuntimeConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Control Plane 运行配置格式不正确");
  }
  return parsed.data;
};

export const requireDatabaseUrl = (
  environment: Readonly<Record<string, string | undefined>>,
): string => {
  const value = environment.FORGEX_DATABASE_URL;
  if (!value) {
    throw new Error("缺少 FORGEX_DATABASE_URL");
  }
  if (value.length > 4_096) {
    throw new Error("FORGEX_DATABASE_URL 不是有效的 PostgreSQL 地址");
  }
  try {
    const parsed = new URL(value);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error("FORGEX_DATABASE_URL 不是有效的 PostgreSQL 地址");
  }
  return value;
};

const tokenPattern = /^[A-Za-z0-9._~-]{24,512}$/u;

const presentedTokenDigest = (
  authorization: string | undefined,
  scheme: "Bearer" | "Runner",
): string | null => {
  const prefix = `${scheme} `;
  if (!authorization?.startsWith(prefix)) return null;
  const token = authorization.slice(prefix.length);
  if (!tokenPattern.test(token)) return null;
  return createHash("sha256").update(token, "utf8").digest("hex");
};

const uniqueEntries = <T extends { tokenSha256: string }>(
  entries: readonly T[],
  label: string,
): Map<string, T> => {
  const result = new Map<string, T>();
  for (const entry of entries) {
    if (result.has(entry.tokenSha256)) {
      throw new Error(`${label}令牌摘要不能重复`);
    }
    result.set(entry.tokenSha256, entry);
  }
  return result;
};

export class HashedSessionAuthenticator implements SessionAuthenticator {
  readonly #sessions: Map<
    string,
    { tokenSha256: string; principal: AuthenticatedPrincipal }
  >;

  constructor(
    entries: ReadonlyArray<{
      tokenSha256: string;
      principal: AuthenticatedPrincipal;
    }>,
  ) {
    const parsed = z
      .array(
        z.object({ tokenSha256: sha256, principal: principalSchema }).strict(),
      )
      .min(1)
      .max(500)
      .parse(entries);
    this.#sessions = uniqueEntries(parsed, "人员会话");
  }

  async authenticate(
    authorization: string | undefined,
  ): Promise<AuthenticatedPrincipal | null> {
    const digest = presentedTokenDigest(authorization, "Bearer");
    const session = digest ? this.#sessions.get(digest) : undefined;
    return session ? structuredClone(session.principal) : null;
  }
}

export class HashedRunnerSessionAuthenticator implements RunnerSessionAuthenticator {
  readonly #sessions: Map<
    string,
    { tokenSha256: string; runner: AuthenticatedRunner }
  >;

  constructor(
    entries: ReadonlyArray<{
      tokenSha256: string;
      runner: AuthenticatedRunner;
    }>,
  ) {
    const parsed = z
      .array(
        z
          .object({
            tokenSha256: sha256,
            runner: AuthenticatedRunnerSchema,
          })
          .strict(),
      )
      .max(100)
      .parse(entries);
    this.#sessions = uniqueEntries(parsed, "Runner 会话");
  }

  async authenticate(
    authorization: string | undefined,
  ): Promise<AuthenticatedRunner | null> {
    const digest = presentedTokenDigest(authorization, "Runner");
    const session = digest ? this.#sessions.get(digest) : undefined;
    return session ? structuredClone(session.runner) : null;
  }
}
