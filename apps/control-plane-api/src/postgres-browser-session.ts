import { createHash, randomBytes } from "node:crypto";

import type { AuthenticatedPrincipal } from "@forgex/application";

import type { BrowserSessionManager } from "./browser-session.js";
import type { ProductionPostgresPool } from "./production.js";
import { AuthenticatedPrincipalRuntimeSchema } from "./runtime-config.js";

const digest = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

export class PostgresBrowserSessionManager implements BrowserSessionManager {
  readonly #pool: ProductionPostgresPool;
  readonly #projectKey: string;
  readonly #repositoryKey: string;
  readonly #authRealmRevision: string;

  constructor(
    pool: ProductionPostgresPool,
    scope: {
      projectKey: string;
      repositoryKey: string;
      authRealmRevision: string;
    },
  ) {
    this.#pool = pool;
    this.#projectKey = scope.projectKey;
    this.#repositoryKey = scope.repositoryKey;
    this.#authRealmRevision = scope.authRealmRevision;
  }

  async create(
    principal: AuthenticatedPrincipal,
    maxAgeSeconds: number,
  ): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.#pool.query(
      "DELETE FROM forgex_browser_sessions WHERE expires_at <= now()",
    );
    await this.#pool.query(
      "INSERT INTO forgex_browser_sessions (session_digest, tenant_key, project_key, repository_key, auth_realm_revision, actor_key, principal, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now() + ($8 * interval '1 second')) ON CONFLICT (tenant_key, project_key, repository_key, actor_key) DO UPDATE SET session_digest = EXCLUDED.session_digest, auth_realm_revision = EXCLUDED.auth_realm_revision, principal = EXCLUDED.principal, expires_at = EXCLUDED.expires_at, created_at = now()",
      [
        digest(token),
        principal.tenantKey,
        this.#projectKey,
        this.#repositoryKey,
        this.#authRealmRevision,
        principal.actorKey,
        JSON.stringify(principal),
        maxAgeSeconds,
      ],
    );
    return token;
  }

  async authenticate(token: string): Promise<AuthenticatedPrincipal | null> {
    const result = await this.#pool.query(
      "SELECT principal FROM forgex_browser_sessions WHERE session_digest = $1 AND project_key = $2 AND repository_key = $3 AND auth_realm_revision = $4 AND expires_at > now()",
      [
        digest(token),
        this.#projectKey,
        this.#repositoryKey,
        this.#authRealmRevision,
      ],
    );
    const row = result.rows[0];
    if (!row || typeof row !== "object" || !("principal" in row)) return null;
    const value =
      typeof row.principal === "string"
        ? (JSON.parse(row.principal) as unknown)
        : row.principal;
    const parsed = AuthenticatedPrincipalRuntimeSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error("数据库中的浏览器会话格式不正确");
    }
    return parsed.data;
  }

  async revoke(token: string): Promise<void> {
    await this.#pool.query(
      "DELETE FROM forgex_browser_sessions WHERE session_digest = $1 AND project_key = $2 AND repository_key = $3 AND auth_realm_revision = $4",
      [
        digest(token),
        this.#projectKey,
        this.#repositoryKey,
        this.#authRealmRevision,
      ],
    );
  }

  async revokePrincipal(tenantKey: string, actorKey: string): Promise<void> {
    await this.#pool.query(
      "DELETE FROM forgex_browser_sessions WHERE tenant_key = $1 AND actor_key = $2 AND project_key = $3 AND repository_key = $4",
      [tenantKey, actorKey, this.#projectKey, this.#repositoryKey],
    );
  }
}
