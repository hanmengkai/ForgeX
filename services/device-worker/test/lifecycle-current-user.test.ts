import { describe, expect, it } from "vitest";
import {
  currentUserCodexArguments,
  currentUserCodexEnvironment,
  currentUserMacProxy,
} from "../src/current-user-codex.js";

describe("生命周期当前用户 Codex 权限", () => {
  it("读取当前用户系统代理并保留回环例外，不接受命令或无效端口", () => {
    expect(
      currentUserMacProxy(
        "HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 7890\nHTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890",
      ),
    ).toEqual({
      HTTP_PROXY: "http://127.0.0.1:7890",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "127.0.0.1,localhost,::1",
    });
    expect(
      currentUserMacProxy(
        "HTTPEnable : 1\nHTTPProxy : $(bad)\nHTTPPort : 99999",
      ),
    ).toEqual({});
  });
  it("复用登录主目录但不继承密钥，强制关闭命令与用户配置", () => {
    const env = currentUserCodexEnvironment({
      HOME: "/Users/sample",
      PATH: "/usr/bin",
      CODEX_HOME: "/Users/sample/.codex",
      OPENAI_API_KEY: "不能传递",
      CODEX_API_KEY: "不能传递",
      FORGEX_TOKEN: "不能传递",
    });
    expect(env).toEqual({
      HOME: "/Users/sample",
      PATH: "/usr/bin",
      CODEX_HOME: "/Users/sample/.codex",
    });
    const args = currentUserCodexArguments({
      workspacePath: "/private/tmp/sample",
      schemaPath: "/private/tmp/schema.json",
      reasoningEffort: "medium",
    });
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("features.shell_tool=false");
    expect(args).toContain("features.unified_exec=false");
    expect(args).toContain('cli_auth_credentials_store="auto"');
    expect(args).toContain("mcp_servers.forgex_workspace.required=true");
  });
});
