import path from "node:path";
import { realpath } from "node:fs/promises";
import {
  initializeDurableSample,
  buildDurableControlPlane,
} from "./durable-stack.mjs";
const root = path.resolve(process.argv[2] ?? ".forgex-local/durable-p0");
const port = Number(process.env.FORGEX_SAMPLE_PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("隔离控制面端口格式不正确");
await initializeDurableSample({
  root,
  origin: `http://127.0.0.1:${port}`,
  mode: process.env.FORGEX_SAMPLE_MODE === "fixture" ? "fixture" : "codex",
});
const { app } = await buildDurableControlPlane(await realpath(root));
const origin = await app.listen({
  host: "127.0.0.1",
  port,
});
console.log(
  `持久化隔离控制面已就绪：${origin}；请另行启动私有配置对应的独立 Worker`,
);
const stop = () => void app.close().then(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
