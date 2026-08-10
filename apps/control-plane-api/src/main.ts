import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { createProductionControlPlane } from "./production.js";
import {
  loadControlPlaneRuntimeConfig,
  requireDatabaseUrl,
} from "./runtime-config.js";

const SERVICE_VERSION = "0.1.0";

export const startControlPlane = async (
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const configPath = environment.FORGEX_CONTROL_PLANE_CONFIG;
  if (!configPath) {
    throw new Error("缺少 FORGEX_CONTROL_PLANE_CONFIG");
  }
  const config = await loadControlPlaneRuntimeConfig(configPath);
  const pool = new Pool({
    connectionString: requireDatabaseUrl(environment),
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  const app = createProductionControlPlane({
    config,
    pool,
    serviceVersion: SERVICE_VERSION,
    logger: true,
  });
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      await app.close();
      await pool.end();
    })();
    return stopping;
  };
  return { app, pool, stop };
};

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  void startControlPlane()
    .then(({ stop }) => {
      const shutdown = () => {
        void stop()
          .catch(() => {
            process.exitCode = 1;
          })
          .finally(() => {
            process.removeListener("SIGINT", shutdown);
            process.removeListener("SIGTERM", shutdown);
          });
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch(() => {
      console.error(
        "ForgeX Control Plane 启动失败，请检查运行配置与数据库状态",
      );
      process.exitCode = 1;
    });
}
