import { createHash, randomBytes } from "node:crypto";

import type { AuthenticatedPrincipal } from "@forgex/application";

export interface WorkerEnrollmentGrant {
  principal: AuthenticatedPrincipal;
  deviceName: string;
  accountName: string;
}

export interface WorkerEnrollmentManager {
  issue(
    principal: AuthenticatedPrincipal,
    deviceName: string,
    accountName: string,
    maxAgeSeconds: number,
  ): Promise<{ token: string; expiresAt: string }>;
  authorize(
    token: string,
    accountFingerprint: string,
  ): Promise<WorkerEnrollmentGrant | null>;
}

interface EnrollmentRecord extends WorkerEnrollmentGrant {
  expiresAtMs: number;
  fingerprintDigest: string | null;
}

const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export class InMemoryWorkerEnrollmentManager implements WorkerEnrollmentManager {
  readonly #clock: () => Date;
  readonly #records = new Map<string, EnrollmentRecord>();

  constructor(options: { clock?: () => Date } = {}) {
    this.#clock = options.clock ?? (() => new Date());
  }

  async issue(
    principal: AuthenticatedPrincipal,
    deviceName: string,
    accountName: string,
    maxAgeSeconds: number,
  ): Promise<{ token: string; expiresAt: string }> {
    for (const [key, record] of this.#records) {
      if (
        record.expiresAtMs <= this.#clock().getTime() ||
        (record.principal.tenantKey === principal.tenantKey &&
          record.principal.actorKey === principal.actorKey)
      ) {
        this.#records.delete(key);
      }
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAtMs = this.#clock().getTime() + maxAgeSeconds * 1_000;
    this.#records.set(digest(token), {
      principal: structuredClone(principal),
      deviceName,
      accountName,
      expiresAtMs,
      fingerprintDigest: null,
    });
    return { token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  async authorize(
    token: string,
    accountFingerprint: string,
  ): Promise<WorkerEnrollmentGrant | null> {
    const record = this.#records.get(digest(token));
    if (!record) return null;
    if (record.expiresAtMs <= this.#clock().getTime()) {
      this.#records.delete(digest(token));
      return null;
    }
    const fingerprintDigest = digest(accountFingerprint);
    if (
      record.fingerprintDigest !== null &&
      record.fingerprintDigest !== fingerprintDigest
    ) {
      return null;
    }
    record.fingerprintDigest = fingerprintDigest;
    return {
      principal: structuredClone(record.principal),
      deviceName: record.deviceName,
      accountName: record.accountName,
    };
  }
}
