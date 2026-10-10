import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = path.join(
  root,
  ".forgex-local",
  "p0-ai",
  new Date().toISOString().replaceAll(":", "-"),
);
console.log(`真实 AI 隔离验收证据：${evidence}`);
const child = spawn(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "lifecycle-ai-live.integration.test.ts",
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${path.join(evidence, "vitest.json")}`,
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      TMPDIR: await realpath(tmpdir()),
      FORGEX_LIVE_AI: "1",
      FORGEX_AI_EVIDENCE_PATH: evidence,
    },
  },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
