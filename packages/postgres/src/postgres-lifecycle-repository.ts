import { z } from "zod";
import {
  emptyLifecycleStore,
  LifecycleStoreSchema,
  type LifecycleRepository,
  type LifecycleStore,
} from "@forgex/application";
import type { PostgresPool } from "./postgres-worker-fleet-repository.js";

export class PostgresLifecycleRepository implements LifecycleRepository {
  constructor(readonly pool: PostgresPool) {}
  async transaction<T>(
    tenantKey: string,
    operation: (state: LifecycleStore) => Promise<T> | T,
  ): Promise<T> {
    const tenant = z.string().uuid().parse(tenantKey);
    const client = await this.pool.connect();
    let started = false;
    try {
      await client.query("BEGIN");
      started = true;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`forgex:lifecycle:v2:${tenant}`],
      );
      const result = await client.query(
        "SELECT state FROM forgex_lifecycle_states WHERE tenant_key = $1 FOR UPDATE",
        [tenant],
      );
      const row = result.rows[0] as { state: unknown } | undefined;
      const state = row
        ? LifecycleStoreSchema.parse(
            typeof row.state === "string" ? JSON.parse(row.state) : row.state,
          )
        : emptyLifecycleStore();
      const before = JSON.stringify(state);
      const value = await operation(state);
      const validated = LifecycleStoreSchema.parse(state);
      if (JSON.stringify(validated) !== before)
        await client.query(
          "INSERT INTO forgex_lifecycle_states (tenant_key, schema_version, state) VALUES ($1, 2, $2::jsonb) ON CONFLICT (tenant_key) DO UPDATE SET state = EXCLUDED.state, updated_at = now()",
          [tenant, JSON.stringify(validated)],
        );
      await client.query("COMMIT");
      started = false;
      return value;
    } catch (error) {
      if (started) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
