import path from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readDurableManifest } from "./durable-stack.mjs";
import { FileLifecycleJournal } from "../../services/device-worker/dist/lifecycle-runtime.js";
import { SampleLifecycleAdapter } from "../../services/device-worker/dist/lifecycle-sample-adapter.js";

const root = await realpath(
  path.resolve(process.argv[2] ?? ".forgex-local/durable-p0"),
);
const manifest = await readDurableManifest(root),
  releases = [];
try {
  // 先取得全部执行日志的排他锁，避免清理期间另一个执行器再次部署。
  for (const { name } of manifest.executors)
    releases.push(
      await new FileLifecycleJournal(
        path.join(root, "workers", name, "journal"),
      ).acquire(),
    );
  for (const { name } of manifest.executors)
    await new SampleLifecycleAdapter({
      root: path.join(root, "workers", name, "pipeline"),
      sourcePath: fileURLToPath(new URL("./app.mjs", import.meta.url)),
      durableDeployments: true,
    }).close();
  console.log("隔离部署已按环境与进程身份核对后停止，需求及执行记录已保留");
} finally {
  for (const release of releases.reverse()) await release();
}
