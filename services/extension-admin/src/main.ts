import { parseArgs } from "node:util";

import {
  loadMcpReleaseInput,
  loadPreparedMcpHealthRefresh,
  loadPreparedMcpRelease,
  prepareMcpHealthRefresh,
  prepareMcpRelease,
  publishPreparedMcpHealthRefresh,
  publishPreparedMcpRelease,
} from "./mcp-admin.js";
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
    source: { type: "string" },
  },
});

const required = (
  name: "input" | "output" | "config" | "bundle" | "source",
): string => {
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
} else if (command === "mcp-pack") {
  const bundle = await prepareMcpRelease(
    await loadMcpReleaseInput(required("input")),
    { configPath: required("config"), outputPath: required("output") },
  );
  process.stdout.write(
    `MCP 发布包已生成：${required("output")}\nMCP：${bundle.manifest.serverKey}#${bundle.manifest.revision}\n`,
  );
} else if (command === "mcp-release") {
  const result = await publishPreparedMcpRelease({
    configPath: required("config"),
    bundle: await loadPreparedMcpRelease(required("bundle")),
  });
  process.stdout.write(
    `MCP 已发布、登记健康证明并启用：${result.serverKey}#${result.revision}\n`,
  );
} else if (command === "mcp-health-pack") {
  const bundle = await prepareMcpHealthRefresh(
    await loadMcpReleaseInput(required("input")),
    {
      configPath: required("config"),
      sourceBundle: await loadPreparedMcpRelease(required("source")),
      outputPath: required("output"),
    },
  );
  process.stdout.write(
    `MCP 健康续期包已生成：${required("output")}\nMCP：${bundle.health.payload.serverKey}#${bundle.health.payload.serverRevision}\n`,
  );
} else if (command === "mcp-health-release") {
  const result = await publishPreparedMcpHealthRefresh({
    configPath: required("config"),
    bundle: await loadPreparedMcpHealthRefresh(required("bundle")),
  });
  process.stdout.write(
    result.status === "recovered"
      ? `MCP 健康证明已登记并从熔断恢复：${result.serverKey}\n`
      : `MCP 健康证明已续期：${result.serverKey}\n`,
  );
} else {
  throw new Error(
    "扩展管理命令只支持 bootstrap、pack、release、mcp-pack、mcp-release、mcp-health-pack 或 mcp-health-release",
  );
}
