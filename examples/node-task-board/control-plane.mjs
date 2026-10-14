import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { createProductionControlPlane } from "../../apps/control-plane-api/dist/production.js";
import { ControlPlaneRuntimeConfigSchema } from "../../apps/control-plane-api/dist/runtime-config.js";
import { loadPostgresMigrations } from "../../packages/postgres/dist/index.js";
import { assertLifecyclePrivatePath } from "../../services/device-worker/dist/lifecycle-runtime.js";
const root = path.resolve(process.argv[2]);
const file = path.join(root, "controller.json");
await assertLifecyclePrivatePath(file);
const privateConfig = JSON.parse(await readFile(file, "utf8"));
const pool = new Pool({
  connectionString: process.env.FORGEX_TEST_DATABASE_URL,
  options: `-c search_path=${privateConfig.schema}`,
  max: 8,
});
const app = createProductionControlPlane({
  config: ControlPlaneRuntimeConfigSchema.parse(privateConfig.config),
  authRealmRevision: privateConfig.authRealmRevision,
  pool,
  migrations: await loadPostgresMigrations(
    path.resolve("packages/postgres/migrations"),
  ),
  executionLogRoot: path.join(root, "execution-logs"),
});
app.addHook("onClose", async () => {
  await pool.end();
});
const origin = await app.listen({
  host: "127.0.0.1",
  port: Number(process.env.FORGEX_NODE_PORT ?? 0),
});
console.log(`正式 PostgreSQL 测试控制面已就绪：${origin}`);
process.once("SIGTERM", () => void app.close());
