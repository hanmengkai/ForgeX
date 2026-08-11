import { createHash, randomBytes } from "node:crypto";

import type { AuthenticatedPrincipal } from "@forgex/application";

export interface BrowserSessionManager {
  create(
    principal: AuthenticatedPrincipal,
    maxAgeSeconds: number,
  ): Promise<string>;
  authenticate(token: string): Promise<AuthenticatedPrincipal | null>;
  revoke(token: string): Promise<void>;
  revokePrincipal(tenantKey: string, actorKey: string): Promise<void>;
}

export interface InMemoryBrowserSessionManagerOptions {
  clock?: () => Date;
}

interface BrowserSessionRecord {
  principal: AuthenticatedPrincipal;
  expiresAtMs: number;
}

const digest = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

export class InMemoryBrowserSessionManager implements BrowserSessionManager {
  readonly #clock: () => Date;
  readonly #sessions = new Map<string, BrowserSessionRecord>();

  constructor(options: InMemoryBrowserSessionManagerOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
  }

  async create(
    principal: AuthenticatedPrincipal,
    maxAgeSeconds: number,
  ): Promise<string> {
    for (const [key, session] of this.#sessions) {
      if (
        session.expiresAtMs <= this.#clock().getTime() ||
        (session.principal.tenantKey === principal.tenantKey &&
          session.principal.actorKey === principal.actorKey)
      ) {
        this.#sessions.delete(key);
      }
    }
    const token = randomBytes(32).toString("base64url");
    this.#sessions.set(digest(token), {
      principal: structuredClone(principal),
      expiresAtMs: this.#clock().getTime() + maxAgeSeconds * 1_000,
    });
    return token;
  }

  async authenticate(token: string): Promise<AuthenticatedPrincipal | null> {
    const key = digest(token);
    const session = this.#sessions.get(key);
    if (!session) return null;
    if (this.#clock().getTime() >= session.expiresAtMs) {
      this.#sessions.delete(key);
      return null;
    }
    return structuredClone(session.principal);
  }

  async revoke(token: string): Promise<void> {
    this.#sessions.delete(digest(token));
  }

  async revokePrincipal(tenantKey: string, actorKey: string): Promise<void> {
    for (const [key, session] of this.#sessions) {
      if (
        session.principal.tenantKey === tenantKey &&
        session.principal.actorKey === actorKey
      ) {
        this.#sessions.delete(key);
      }
    }
  }
}
