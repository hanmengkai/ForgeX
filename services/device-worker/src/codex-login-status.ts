import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export type CodexStatusCommandRunner = (
  command: string,
  args: string[],
  options: {
    env: Record<string, string>;
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
  },
) => Promise<{ stdout: string; stderr: string }>;
// 状态核对只运行固定 CLI 参数，原始输出及登录文件均不离开本机。
export async function codexLoginStatus(
  home: string,
  run: CodexStatusCommandRunner = exec,
): Promise<"logged_in" | "needs_login" | "unknown"> {
  if (process.platform !== "darwin") return "unknown";
  const command =
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
  try {
    const env = {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
      CODEX_HOME: home,
    };
    const version = await run(command, ["--version"], {
      env,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4096,
    });
    if (version.stdout.trim() !== "codex-cli 0.162.0-alpha.17.2")
      return "unknown";
    const result = await run(command, ["login", "status"], {
      env,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4096,
    });
    return /Logged in using/iu.test(`${result.stdout}\n${result.stderr}`)
      ? "logged_in"
      : "unknown";
  } catch (error) {
    const message = error as { stdout?: string; stderr?: string };
    return /Not logged in/iu.test(
      `${message.stdout ?? ""}\n${message.stderr ?? ""}`,
    )
      ? "needs_login"
      : "unknown";
  }
}
