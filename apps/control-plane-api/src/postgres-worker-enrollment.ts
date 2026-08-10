import { createHash, randomBytes } from "node:crypto";

import type { WorkerEnrollmentManager } from "./worker-enrollment.js";
import type { ProductionPostgresPool } from "./production.js";
import { AuthenticatedPrincipalRuntimeSchema } from "./runtime-config.js";

const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const rowValue = (row: unknown, key: string): unknown =>
  typeof row === "object" && row !== null && key in row
    ? (row as Record<string, unknown>)[key]
    : undefined;

export class PostgresWorkerEnrollmentManager implements WorkerEnrollmentManager {
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

  async issue(
    principal: Parameters<WorkerEnrollmentManager["issue"]>[0],
    deviceName: string,
    accountName: string,
    maxAgeSeconds: number,
  ): Promise<{ token: string; expiresAt: string }> {
    const token = randomBytes(32).toString("base64url");
    const result = await this.#pool.query(
      "INSERT INTO forgex_worker_enrollments (token_digest, tenant_key, project_key, repository_key, auth_realm_revision, actor_key, principal, device_name, account_name, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, now() + ($10 * interval '1 second')) ON CONFLICT (tenant_key, project_key, repository_key, actor_key) DO UPDATE SET token_digest = EXCLUDED.token_digest, auth_realm_revision = EXCLUDED.auth_realm_revision, principal = EXCLUDED.principal, device_name = EXCLUDED.device_name, account_name = EXCLUDED.account_name, fingerprint_digest = NULL, expires_at = EXCLUDED.expires_at, created_at = now() RETURNING expires_at",
      [
        digest(token),
        principal.tenantKey,
        this.#projectKey,
        this.#repositoryKey,
        this.#authRealmRevision,
        principal.actorKey,
        JSON.stringify(principal),
        deviceName,
        accountName,
        maxAgeSeconds,
      ],
    );
    const expiresAt = rowValue(result.rows[0], "expires_at");
    if (!(expiresAt instanceof Date) && typeof expiresAt !== "string") {
      throw new Error("数据库未返回设备接入码的过期时间");
    }
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  async authorize(token: string, accountFingerprint: string) {
    const result = await this.#pool.query(
      "UPDATE forgex_worker_enrollments SET fingerprint_digest = COALESCE(fingerprint_digest, $2) WHERE token_digest = $1 AND project_key = $3 AND repository_key = $4 AND auth_realm_revision = $5 AND expires_at > now() AND (fingerprint_digest IS NULL OR fingerprint_digest = $2) RETURNING principal, device_name, account_name",
      [
        digest(token),
        digest(accountFingerprint),
        this.#projectKey,
        this.#repositoryKey,
        this.#authRealmRevision,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    const rawPrincipal = rowValue(row, "principal");
    const principal = AuthenticatedPrincipalRuntimeSchema.safeParse(
      typeof rawPrincipal === "string"
        ? (JSON.parse(rawPrincipal) as unknown)
        : rawPrincipal,
    );
    const deviceName = rowValue(row, "device_name");
    const accountName = rowValue(row, "account_name");
    if (
      !principal.success ||
      typeof deviceName !== "string" ||
      typeof accountName !== "string"
    ) {
      throw new Error("数据库中的设备接入记录格式不正确");
    }
    return { principal: principal.data, deviceName, accountName };
  }
}
