import { parseArgs } from "node:util";

import {
  bootstrapExtensionAdmin,
  loadExtensionAdminBootstrapInput,
  loadPreparedSkillRelease,
  loadSkillReleaseInput,
  prepareSkillRelease,
  publishPreparedSkillRelease,
} from "./skill-admin.js";

const parsed = parseArgs({
  allowPositionals: true,
  strict: true,
  options: {
    input: { type: "string" },
    output: { type: "string" },
    config: { type: "string" },
    bundle: { type: "string" },
  },
});

const required = (name: "input" | "output" | "config" | "bundle"): string => {
  const value = parsed.values[name];
  if (!value) throw new Error(`扩展管理命令需要 --${name}`);
  return value;
};

const command = parsed.positionals[0];
if (command === "bootstrap") {
  const generated = await bootstrapExtensionAdmin(
    await loadExtensionAdminBootstrapInput(required("input")),
    { outputDirectory: required("output") },
  );
  process.stdout.write(
    `扩展管理配置已生成：${generated.configPath}\n控制面授权片段：${generated.controlPlaneFragmentPath}\n`,
  );
} else if (command === "pack") {
  const bundle = await prepareSkillRelease(
    await loadSkillReleaseInput(required("input")),
    { configPath: required("config"), outputPath: required("output") },
  );
  process.stdout.write(
    `Skill 发布包已生成：${required("output")}\nSkill：${bundle.manifest.skillKey}@${bundle.manifest.version}\n`,
  );
} else if (command === "release") {
  const result = await publishPreparedSkillRelease({
    configPath: required("config"),
    bundle: await loadPreparedSkillRelease(required("bundle")),
  });
  process.stdout.write(
    result.status === "activated"
      ? `Skill 已发布、评测并激活：${result.skillKey}\n`
      : `Skill 已发布但基线评测未通过：${result.skillKey}\n`,
  );
} else {
  throw new Error("扩展管理命令只支持 bootstrap、pack 或 release");
}
