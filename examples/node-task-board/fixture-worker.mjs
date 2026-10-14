import { createPrivateKey } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  LifecycleWorkerConfigSchema,
  createLifecycleWorkerAdapter,
} from "../../services/device-worker/dist/lifecycle-config.js";
import { CodexLifecycleAdapter } from "../../services/device-worker/dist/lifecycle-codex-adapter.js";
import { DurableLifecycleAdapter } from "../../services/device-worker/dist/lifecycle-receipt.js";
import {
  FileLifecycleJournal,
  HttpLifecycleClient,
  LifecycleExecutorRuntime,
  assertLifecyclePrivatePath,
} from "../../services/device-worker/dist/lifecycle-runtime.js";
import { fixtureSource, fixtureResponse } from "./fixture.mjs";
import { catalog } from "./trusted-suites.mjs";

const file = path.resolve(process.argv[2]);
await assertLifecyclePrivatePath(file);
const config = LifecycleWorkerConfigSchema.parse(
  JSON.parse(await readFile(file, "utf8")),
);
await assertLifecyclePrivatePath(config.privateKeyPath);
const { adapter: configured } = createLifecycleWorkerAdapter(config, [
  file,
  config.privateKeyPath,
  config.journalRoot,
]);
const runner = {
  run: async (input) => {
    const stage = JSON.parse(
      input.prompt
        .split("<lifecycle_input>\n")[1]
        .split("\n</lifecycle_input>")[0],
    );
    // 阶段由输出 Schema 判断，合成输入不加载本机登录。
    const properties = input.outputSchema.properties;
    const kind = properties?.kind?.const;
    const phase =
      kind === "requirements"
        ? "requirements_ai"
        : kind === "design"
          ? "design_ai"
          : properties?.cases
            ? "testing"
            : "development";
    if (phase === "development")
      await writeFile(
        path.join(input.workspacePath, "src/tasks.ts"),
        fixtureSource,
      );
    void stage;
    return {
      threadId: null,
      finalResponse: JSON.stringify(fixtureResponse(phase, catalog)),
    };
  },
};
const adapter = config.execution
  ? new CodexLifecycleAdapter({
      project: config.execution.project,
      runner,
      codexHomePath: config.execution.codexHomePath,
      protectedPaths: [file, config.privateKeyPath, config.journalRoot],
      pipeline: configured.options.pipeline,
      instructions: config.execution.instructions,
      testingAgent: true,
      allowedDevelopmentFiles: config.execution.allowedDevelopmentFiles,
    })
  : configured;
const journal = new FileLifecycleJournal(config.journalRoot),
  release = await journal.acquire();
const runtime = new LifecycleExecutorRuntime({
  client: new HttpLifecycleClient({
    origin: config.controlPlaneOrigin,
    token: config.token,
  }),
  adapter: new DurableLifecycleAdapter(
    path.join(config.journalRoot, "receipts"),
    adapter,
  ),
  journal,
  privateKey: createPrivateKey(await readFile(config.privateKeyPath)),
  onExecutionError: (message) => console.error(message),
});
let stopped = false;
process.once("SIGTERM", () => {
  stopped = true;
});
console.log("显式 fixture 独立执行器已就绪");
try {
  while (!stopped) {
    try {
      await runtime.tick();
    } catch {
      console.error("fixture 等待回执确认");
    }
    await new Promise((r) => setTimeout(r, 200));
  }
} finally {
  await release();
}
