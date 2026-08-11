import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  SkillEvaluationAuthority,
  SkillPackageCodec,
} from "@forgex/extensions";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ExtensionAdminBootstrapInputSchema,
  SkillReleaseInputSchema,
  bootstrapExtensionAdmin,
  prepareSkillRelease,
  publishPreparedSkillRelease,
} from "../src/index.js";

const tenantKey = "10000000-0000-4000-8000-000000000001";
const projectKey = "20000000-0000-4000-8000-000000000002";
const roots: string[] = [];

const fixture = async () => {
  const root = path.join(
    os.homedir(),
    `.forgex-extension-admin-${crypto.randomUUID()}`,
  );
  roots.push(root);
  const outputDirectory = path.join(root, "admin");
  const sourceDirectory = path.join(root, "skill");
  await Promise.all([
    mkdir(outputDirectory, { recursive: true, mode: 0o700 }),
    mkdir(path.join(sourceDirectory, "references"), {
      recursive: true,
      mode: 0o700,
    }),
  ]);
  if (process.platform !== "win32") {
    await Promise.all([
      chmod(root, 0o700),
      chmod(outputDirectory, 0o700),
      chmod(sourceDirectory, 0o700),
      chmod(path.join(sourceDirectory, "references"), 0o700),
    ]);
  }
  const administratorSessionKeyPath = path.join(root, "administrator.key");
  await Promise.all([
    writeFile(administratorSessionKeyPath, "administrator-session-key\n", {
      mode: 0o600,
    }),
    writeFile(
      path.join(sourceDirectory, "SKILL.md"),
      "# 访客预约交付\n\n先阅读业务规则，再按验收条件实现预约流程。\n",
      { mode: 0o600 },
    ),
    writeFile(
      path.join(sourceDirectory, "references", "policy.md"),
      "# 业务规则\n\n预约必须保留联系人和到访时间。\n",
      { mode: 0o600 },
    ),
  ]);
  const generated = await bootstrapExtensionAdmin(
    {
      schemaVersion: 1,
      administratorName: "扩展管理员一号",
      controlPlaneUrl: "https://forgex.example.test",
      administratorSessionKeyPath,
      scope: { tenantKey, projectKey },
      requestTimeoutMs: 5_000,
    },
    {
      outputDirectory,
      assertPrivatePath: async () => undefined,
    },
  );
  return {
    root,
    outputDirectory,
    sourceDirectory,
    administratorSessionKeyPath,
    generated,
  };
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("extension admin", () => {
  it("仓库内 bootstrap 与 Skill 发布输入示例符合公开协议", async () => {
    const [bootstrap, release] = await Promise.all([
      readFile(
        path.resolve(
          "services/extension-admin/extension-admin.bootstrap.example.json",
        ),
        "utf8",
      ),
      readFile(
        path.resolve("services/extension-admin/skill.release.example.json"),
        "utf8",
      ),
    ]);

    expect(() =>
      ExtensionAdminBootstrapInputSchema.parse(JSON.parse(bootstrap)),
    ).not.toThrow();
    expect(() =>
      SkillReleaseInputSchema.parse(JSON.parse(release)),
    ).not.toThrow();
  });

  it("生成私有评测身份和不含管理员令牌的控制面公钥片段", async () => {
    const setup = await fixture();
    const [config, fragment, session, privateKey] = await Promise.all([
      readFile(setup.generated.configPath, "utf8"),
      readFile(setup.generated.controlPlaneFragmentPath, "utf8"),
      readFile(setup.administratorSessionKeyPath, "utf8"),
      readFile(setup.generated.evaluatorPrivateKeyPath, "utf8"),
    ]);

    expect(JSON.parse(config)).toMatchObject({
      schemaVersion: 1,
      controlPlaneUrl: "https://forgex.example.test",
      scope: { tenantKey, projectKey },
    });
    expect(fragment).not.toContain(session.trim());
    expect(JSON.parse(fragment)).toMatchObject({
      skillEvaluators: [
        {
          evaluatorName: "扩展管理员一号 Skill 基线评测器",
          scopes: [{ tenantKey, projectKey }],
          acceptNewEvaluations: true,
        },
      ],
    });
    expect(privateKey).toContain("PRIVATE KEY");
    if (process.platform !== "win32") {
      expect((await stat(setup.generated.configPath)).mode & 0o077).toBe(0);
    }
  });

  it("重复 bootstrap 拒绝覆盖并保留已有评测私钥", async () => {
    const setup = await fixture();
    const original = await readFile(
      setup.generated.evaluatorPrivateKeyPath,
      "utf8",
    );

    await expect(
      bootstrapExtensionAdmin(
        {
          schemaVersion: 1,
          administratorName: "扩展管理员一号",
          controlPlaneUrl: "https://forgex.example.test",
          administratorSessionKeyPath: setup.administratorSessionKeyPath,
          scope: { tenantKey, projectKey },
          requestTimeoutMs: 5_000,
        },
        {
          outputDirectory: setup.outputDirectory,
          assertPrivatePath: async () => undefined,
        },
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(
      readFile(setup.generated.evaluatorPrivateKeyPath, "utf8"),
    ).resolves.toBe(original);
  });

  it("把 Skill 与文本资源打成不可变制品并签出可验证的基线评测", async () => {
    const setup = await fixture();
    const bundlePath = path.join(setup.outputDirectory, "visitor-skill.json");

    const bundle = await prepareSkillRelease(
      {
        schemaVersion: 1,
        version: "1.0.0",
        name: "访客预约交付助手",
        summary: "帮助团队按照访客业务规则实现可验收的预约能力",
        sourceDirectory: setup.sourceDirectory,
        compatibleBlueprints: ["Web 业务应用"],
        requiredCapabilities: [],
        permissions: {
          workspace: "read_only",
          network: "none",
          commands: "none",
        },
      },
      {
        configPath: setup.generated.configPath,
        outputPath: bundlePath,
        assertPrivatePath: async () => undefined,
      },
    );
    const fragment = JSON.parse(
      await readFile(setup.generated.controlPlaneFragmentPath, "utf8"),
    ) as {
      skillEvaluators: Array<{
        evaluatorKey: string;
        keyId: string;
        evaluatorName: string;
        publicKeyBase64: string;
        scopes: Array<{ tenantKey: string; projectKey: string }>;
      }>;
    };
    const authority = new SkillEvaluationAuthority({
      evaluators: fragment.skillEvaluators,
      clock: () => new Date(bundle.evaluation.payload.producedAt),
    });
    const artifact = Buffer.from(bundle.artifactContentBase64, "base64");

    expect(SkillPackageCodec.decode(artifact)).toEqual({
      schemaVersion: 1,
      instructions:
        "# 访客预约交付\n\n先阅读业务规则，再按验收条件实现预约流程。",
      resources: [
        {
          path: "references/policy.md",
          mediaType: "text/markdown",
          encoding: "utf8",
          content: "# 业务规则\n\n预约必须保留联系人和到访时间。\n",
        },
      ],
    });
    expect(bundle.manifest.artifactHash).toBe(
      createHash("sha256").update(artifact).digest("hex"),
    );
    expect(bundle.evaluation.payload).toMatchObject({
      skillKey: bundle.manifest.skillKey,
      skillVersion: "1.0.0",
      outcome: "passed",
      score: 100,
      scenarioCount: 5,
      passedScenarioCount: 5,
      criticalFailureCount: 0,
    });
    expect(() => authority.verify(bundle.evaluation)).not.toThrow();
    expect(JSON.parse(await readFile(bundlePath, "utf8"))).toEqual(bundle);
  });

  it("打包时逐项验证私有源目录、嵌套目录和源文件", async () => {
    const setup = await fixture();
    const checked = new Set<string>();
    await prepareSkillRelease(
      {
        schemaVersion: 1,
        version: "1.0.0",
        name: "访客预约交付助手",
        summary: "帮助团队按照访客业务规则实现可验收的预约能力",
        sourceDirectory: setup.sourceDirectory,
        compatibleBlueprints: [],
        requiredCapabilities: [],
        permissions: {
          workspace: "read_only",
          network: "none",
          commands: "none",
        },
      },
      {
        configPath: setup.generated.configPath,
        outputPath: path.join(setup.outputDirectory, "checked.json"),
        assertPrivatePath: async (targetPath) => {
          checked.add(path.resolve(targetPath));
        },
      },
    );

    for (const expected of [
      setup.sourceDirectory,
      path.join(setup.sourceDirectory, "SKILL.md"),
      path.join(setup.sourceDirectory, "references"),
      path.join(setup.sourceDirectory, "references", "policy.md"),
    ]) {
      expect(checked).toContain(path.resolve(expected));
    }
  });

  it("用同一个已签名发布包依次发布、登记评测并激活", async () => {
    const setup = await fixture();
    const bundle = await prepareSkillRelease(
      {
        schemaVersion: 1,
        version: "1.0.0",
        name: "访客预约交付助手",
        summary: "帮助团队按照访客业务规则实现可验收的预约能力",
        sourceDirectory: setup.sourceDirectory,
        compatibleBlueprints: [],
        requiredCapabilities: [],
        permissions: {
          workspace: "read_only",
          network: "none",
          commands: "none",
        },
      },
      {
        configPath: setup.generated.configPath,
        outputPath: path.join(setup.outputDirectory, "release.json"),
        assertPrivatePath: async () => undefined,
      },
    );
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher = vi.fn(
      async (input: string | URL | globalThis.Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (calls.length === 1) {
          return new Response(
            JSON.stringify({
              data: {
                status: "已发布",
                links: {
                  self: `/api/v1/extensions/skills/${bundle.manifest.skillKey}`,
                },
              },
            }),
            {
              status: 201,
              headers: {
                "content-type": "application/json",
                location: `/api/v1/extensions/skills/${bundle.manifest.skillKey}`,
              },
            },
          );
        }
        return new Response(null, { status: 204 });
      },
    );

    await expect(
      publishPreparedSkillRelease({
        configPath: setup.generated.configPath,
        bundle,
        fetcher,
        assertPrivatePath: async () => undefined,
      }),
    ).resolves.toEqual({
      status: "activated",
      skillKey: bundle.manifest.skillKey,
    });

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/v1/extensions/skills",
      `/api/v1/extensions/skills/${bundle.manifest.skillKey}/evaluations`,
      `/api/v1/extensions/skills/${bundle.manifest.skillKey}/versions/1.0.0/activate`,
    ]);
    for (const call of calls) {
      expect(call.init).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: "Bearer administrator-session-key",
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      });
    }
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      schemaVersion: 1,
      manifest: bundle.manifest,
      artifactContentBase64: bundle.artifactContentBase64,
    });
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({
      schemaVersion: 1,
      evaluation: bundle.evaluation,
    });
    expect(JSON.parse(String(calls[2]!.init!.body))).toEqual({
      schemaVersion: 1,
    });
  });

  it("不安全权限只登记失败评测，不会调用激活接口", async () => {
    const setup = await fixture();
    const bundle = await prepareSkillRelease(
      {
        schemaVersion: 1,
        version: "1.0.0",
        name: "访客预约交付助手",
        summary: "帮助团队按照访客业务规则实现可验收的预约能力",
        sourceDirectory: setup.sourceDirectory,
        compatibleBlueprints: [],
        requiredCapabilities: [],
        permissions: {
          workspace: "write_scoped",
          network: "none",
          commands: "none",
        },
      },
      {
        configPath: setup.generated.configPath,
        outputPath: path.join(setup.outputDirectory, "unsafe-release.json"),
        assertPrivatePath: async () => undefined,
      },
    );
    const fetcher = vi.fn(async (_input: string | URL | globalThis.Request) =>
      fetcher.mock.calls.length === 1
        ? new Response("{}", {
            status: 201,
            headers: {
              location: `/api/v1/extensions/skills/${bundle.manifest.skillKey}`,
            },
          })
        : new Response(null, { status: 204 }),
    );

    await expect(
      publishPreparedSkillRelease({
        configPath: setup.generated.configPath,
        bundle,
        fetcher,
        assertPrivatePath: async () => undefined,
      }),
    ).resolves.toEqual({
      status: "evaluation_failed",
      skillKey: bundle.manifest.skillKey,
    });
    expect(bundle.evaluation.payload.outcome).toBe("failed");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("拒绝把不受支持的脚本资源打入交付 Skill", async () => {
    const setup = await fixture();
    await writeFile(
      path.join(setup.sourceDirectory, "references", "unsafe.js"),
      "console.log('unsafe')\n",
      { mode: 0o600 },
    );

    await expect(
      prepareSkillRelease(
        {
          schemaVersion: 1,
          version: "1.0.0",
          name: "访客预约交付助手",
          summary: "帮助团队按照访客业务规则实现可验收的预约能力",
          sourceDirectory: setup.sourceDirectory,
          compatibleBlueprints: [],
          requiredCapabilities: [],
          permissions: {
            workspace: "read_only",
            network: "none",
            commands: "none",
          },
        },
        {
          configPath: setup.generated.configPath,
          outputPath: path.join(setup.outputDirectory, "invalid.json"),
          assertPrivatePath: async () => undefined,
        },
      ),
    ).rejects.toThrow("只支持 Markdown、纯文本和 JSON");
  });

  it("在生成发布包前拒绝 Skill 中的疑似明文凭据", async () => {
    const setup = await fixture();
    await writeFile(
      path.join(setup.sourceDirectory, "references", "policy.md"),
      "apiKey=actual-production-secret-123456\n",
      { mode: 0o600 },
    );

    await expect(
      prepareSkillRelease(
        {
          schemaVersion: 1,
          version: "1.0.0",
          name: "访客预约交付助手",
          summary: "帮助团队按照访客业务规则实现可验收的预约能力",
          sourceDirectory: setup.sourceDirectory,
          compatibleBlueprints: [],
          requiredCapabilities: [],
          permissions: {
            workspace: "read_only",
            network: "none",
            commands: "none",
          },
        },
        {
          configPath: setup.generated.configPath,
          outputPath: path.join(setup.outputDirectory, "credential.json"),
          assertPrivatePath: async () => undefined,
        },
      ),
    ).rejects.toThrow("疑似明文凭据");
  });

  it("控制面超限或畸形响应只产生固定本地错误", async () => {
    const setup = await fixture();
    const bundle = await prepareSkillRelease(
      {
        schemaVersion: 1,
        version: "1.0.0",
        name: "访客预约交付助手",
        summary: "帮助团队按照访客业务规则实现可验收的预约能力",
        sourceDirectory: setup.sourceDirectory,
        compatibleBlueprints: [],
        requiredCapabilities: [],
        permissions: {
          workspace: "read_only",
          network: "none",
          commands: "none",
        },
      },
      {
        configPath: setup.generated.configPath,
        outputPath: path.join(setup.outputDirectory, "bounded.json"),
        assertPrivatePath: async () => undefined,
      },
    );
    const marker = "Authorization: Bearer leaked-remote-secret";

    await expect(
      publishPreparedSkillRelease({
        configPath: setup.generated.configPath,
        bundle,
        fetcher: async () =>
          new Response(`${"x".repeat(1_048_576)}${marker}`, { status: 500 }),
        assertPrivatePath: async () => undefined,
      }),
    ).rejects.toThrow("请使用同一个发布包安全重试");
    await expect(
      publishPreparedSkillRelease({
        configPath: setup.generated.configPath,
        bundle,
        fetcher: async () =>
          new Response(marker, {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
        assertPrivatePath: async () => undefined,
      }),
    ).rejects.toThrow("控制面拒绝了扩展管理请求");
  });
});
