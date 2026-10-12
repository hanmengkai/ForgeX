import { describe, it, expect } from "vitest";
import {
  codexLoginStatus,
  type CodexStatusCommandRunner,
} from "../src/codex-login-status.js";
describe.skipIf(process.platform !== "darwin")("本机 Codex 登录核对", () => {
  it("固定命令只传本机登录路径，未知版本和登录异常不能宣称登录成功", async () => {
    let mode = "ok",
      calls = 0;
    const run: CodexStatusCommandRunner = async (command, args, options) => {
      calls++;
      expect(command).toContain("CodexCLI.app");
      expect(Object.keys(options.env).sort()).toEqual([
        "CODEX_HOME",
        "HOME",
        "PATH",
      ]);
      expect(options.env.CODEX_HOME).toBe("/private/test-login");
      if (args[0] === "--version")
        return {
          stdout:
            mode === "version"
              ? "codex-cli 9.0.0"
              : "codex-cli 0.162.0-alpha.17.2",
          stderr: "",
        };
      expect(args).toEqual(["login", "status"]);
      if (mode === "logged-out") throw { stderr: "Not logged in" };
      if (mode === "error") throw new Error("凭据读取异常，不发送原始内容");
      return { stdout: "", stderr: "Logged in using ChatGPT" };
    };
    expect(await codexLoginStatus("/private/test-login", run)).toBe(
      "logged_in",
    );
    mode = "logged-out";
    expect(await codexLoginStatus("/private/test-login", run)).toBe(
      "needs_login",
    );
    mode = "error";
    expect(await codexLoginStatus("/private/test-login", run)).toBe("unknown");
    mode = "version";
    expect(await codexLoginStatus("/private/test-login", run)).toBe("unknown");
    expect(calls).toBe(7);
  });
});
