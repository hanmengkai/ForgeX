import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// 统一临时目录的真实路径，避免 macOS /var 别名触发私有路径保护。
const temporaryRoot = await realpath(tmpdir());
const root = fileURLToPath(new URL("../", import.meta.url));
const child = spawn(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "lifecycle",
    "--reporter=default",
    "--reporter=json",
    "--outputFile=coverage/p0-sample-vitest.json",
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, TMPDIR: temporaryRoot },
  },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
