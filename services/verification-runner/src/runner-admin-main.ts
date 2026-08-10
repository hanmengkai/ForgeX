import { parseArgs } from "node:util";

import {
  bootstrapVerificationRunner,
  finalizeVerificationRunnerPlan,
  loadVerificationRunnerBootstrapInput,
  listVerificationRunnerTargets,
} from "./runner-admin.js";

const parsed = parseArgs({
  allowPositionals: true,
  strict: true,
  options: {
    input: { type: "string" },
    output: { type: "string" },
    bootstrap: { type: "string" },
    plan: { type: "string" },
  },
});
const command = parsed.positionals[0];

if (command === "bootstrap") {
  if (!parsed.values.input || !parsed.values.output) {
    throw new Error("bootstrap 需要 --input 和 --output");
  }
  const input = await loadVerificationRunnerBootstrapInput(parsed.values.input);
  const result = await bootstrapVerificationRunner(input, {
    outputDirectory: parsed.values.output,
  });
  process.stdout.write(
    `Runner 私有材料已生成：${result.bootstrapConfigPath}\n控制面授权片段：${result.controlPlaneFragmentPath}\n`,
  );
} else if (command === "targets") {
  if (!parsed.values.bootstrap) {
    throw new Error("targets 需要 --bootstrap");
  }
  const targets = await listVerificationRunnerTargets(parsed.values.bootstrap);
  process.stdout.write(`${JSON.stringify(targets, null, 2)}\n`);
} else if (command === "plan") {
  if (
    !parsed.values.bootstrap ||
    !parsed.values.plan ||
    !parsed.values.output
  ) {
    throw new Error("plan 需要 --bootstrap、--plan 和 --output");
  }
  await finalizeVerificationRunnerPlan({
    bootstrapConfigPath: parsed.values.bootstrap,
    planPath: parsed.values.plan,
    outputPath: parsed.values.output,
  });
  process.stdout.write(`Runner 可启动配置已生成：${parsed.values.output}\n`);
} else {
  throw new Error("Runner 管理命令只支持 bootstrap、targets 或 plan");
}
