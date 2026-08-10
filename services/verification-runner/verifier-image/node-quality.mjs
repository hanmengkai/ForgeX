#!/usr/bin/env node

import { verifyRepositoryIntegrity } from "./repository-integrity.mjs";

try {
  const result = await verifyRepositoryIntegrity("/workspace");
  process.stdout.write(`${JSON.stringify({ status: "passed", ...result })}\n`);
} catch {
  process.stderr.write("ForgeX 独立仓库完整性验证未通过\n");
  process.exitCode = 1;
}
