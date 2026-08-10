import { createHash } from "node:crypto";

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
    projectKey: internalKey,
    repositoryKey: internalKey,
    sessions: z
      .array(
        z
          .object({ tokenSha256: sha256, principal: principalSchema })
          .strict(),
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
            acceptNewEvidence: z.boolean().optional(),
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
            acceptNewEvaluations: z.boolean().optional(),
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
            acceptNewAttestations: z.boolean().optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export type ControlPlaneRuntimeConfig = z.infer<
  typeof ControlPlaneRuntimeConfigSchema
>;

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

export class HashedRunnerSessionAuthenticator
  implements RunnerSessionAuthenticator
{
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
