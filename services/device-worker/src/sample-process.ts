import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
export async function sampleProcessIdentity(pid: number): Promise<string> {
  if (process.platform !== "darwin" || !Number.isInteger(pid) || pid < 1)
    throw new Error("持久样板发布当前只支持经过验证的 macOS 进程身份");
  const options = {
    encoding: "utf8" as const,
    env: { LC_ALL: "C", TZ: "UTC" },
    timeout: 5000,
    maxBuffer: 4096,
  };
  const [boot, info] = await Promise.all([
    run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], options),
    run("/bin/ps", ["-p", String(pid), "-o", "pid=,lstart="], options),
  ]);
  if (
    !/^[a-fA-F0-9-]{36}$/u.test(boot.stdout.trim()) ||
    !new RegExp(`^${pid}\\s+.+$`, "u").test(info.stdout.trim())
  )
    throw new Error("无法核对隔离发布进程身份");
  return `${boot.stdout.trim().toLowerCase()}:${info.stdout.trim().replace(/\s+/gu, " ")}`;
}
export async function stopSampleProcess(state: {
  pid?: number | undefined;
  processIdentity?: string | undefined;
  port: number;
  artifactDigest: string;
  environmentKey: string;
}): Promise<void> {
  if (!state.pid || !state.processIdentity) return;
  try {
    process.kill(state.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  if ((await sampleProcessIdentity(state.pid)) !== state.processIdentity)
    return;
  const response = await fetch(`http://127.0.0.1:${state.port}/health`, {
    signal: AbortSignal.timeout(2000),
  });
  const report = (await response.json()) as {
    artifactDigest: string;
    environmentKey: string;
    healthy: boolean;
  };
  if (
    !response.ok ||
    !report.healthy ||
    report.artifactDigest !== state.artifactDigest ||
    report.environmentKey !== state.environmentKey
  )
    throw new Error("旧隔离环境身份无法核对，禁止停止未知进程");
  if ((await sampleProcessIdentity(state.pid)) !== state.processIdentity)
    throw new Error("隔离进程身份变化，禁止停止");
  process.kill(state.pid, "SIGTERM");
  for (let n = 0; n < 50; n++) {
    try {
      process.kill(state.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("隔离环境尚未停止，请人工核对后重试");
}
