import {
  ExtensionCatalog,
  type ExtensionCatalogEntry,
} from "@forgex/extensions";

export interface ExtensionCatalogRepository {
  list(tenantKey: string, projectKey: string): Promise<ExtensionCatalogEntry[]>;
  publish(entry: ExtensionCatalogEntry): Promise<void>;
}

const scopeKey = (tenantKey: string, projectKey: string): string =>
  `${tenantKey.toLowerCase()}:${projectKey.toLowerCase()}`;

export class InMemoryExtensionCatalogRepository implements ExtensionCatalogRepository {
  readonly #entriesByScope = new Map<string, ExtensionCatalogEntry[]>();
  readonly #pendingByScope = new Map<string, Promise<void>>();

  async list(
    tenantKey: string,
    projectKey: string,
  ): Promise<ExtensionCatalogEntry[]> {
    await this.#pendingByScope
      .get(scopeKey(tenantKey, projectKey))
      ?.catch(() => undefined);
    return structuredClone(
      this.#entriesByScope.get(scopeKey(tenantKey, projectKey)) ?? [],
    );
  }

  async publish(entry: ExtensionCatalogEntry): Promise<void> {
    const key = scopeKey(entry.tenantKey, entry.projectKey);
    const previous = this.#pendingByScope.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => {
        const catalog = ExtensionCatalog.restoreLatest(
          {
            tenantKey: entry.tenantKey,
            projectKey: entry.projectKey,
          },
          this.#entriesByScope.get(key) ?? [],
        );
        catalog.publish(entry);
        this.#entriesByScope.set(key, catalog.list());
      });
    this.#pendingByScope.set(key, next);
    try {
      await next;
    } finally {
      if (this.#pendingByScope.get(key) === next) {
        this.#pendingByScope.delete(key);
      }
    }
  }
}
