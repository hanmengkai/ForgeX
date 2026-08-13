#!/usr/bin/env node

import { CODEX_PROGRESS_PREFIX } from "./codex-isolation.js";
import { executeIsolatedCodexRun } from "./isolation-launcher.js";

if (process.argv[2] !== "--forgex-codex-run") {
  throw new Error("ForgeX Codex 隔离启动器只接受受控执行协议");
}

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input, "utf8") > 2 * 1024 * 1024) {
    throw new Error("ForgeX Codex 隔离执行请求超过安全上限");
  }
}

const result = await executeIsolatedCodexRun(JSON.parse(input) as unknown, {
  emitProgress: async (event) => {
    if (
      process.stderr.write(`${CODEX_PROGRESS_PREFIX}${JSON.stringify(event)}\n`)
    ) {
      return;
    }
    await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
  },
});
process.stdout.write(JSON.stringify(result));
