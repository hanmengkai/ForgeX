import {
  execFile,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { promisify } from "node:util";

export type ProcessLookup =
  | { kind: "found"; startKey: string }
  | { kind: "missing" }
  | { kind: "unknown" };
export interface DarwinProcessTools {
  run(
    command: string,
    args: string[],
    options: ExecFileOptionsWithStringEncoding,
  ): Promise<{ stdout: string }>;
  probe(pid: number): void;
}
const execFileAsync = promisify(execFile);
const defaultTools: DarwinProcessTools = {
  run: execFileAsync,
  probe: (pid) => {
    process.kill(pid, 0);
  },
};
const months = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const startTimestamp = (stdout: string, pid: number): number | null => {
  const match =
    /^(\d+)\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/u.exec(
      stdout.trim(),
    );
  if (!match || Number(match[1]) !== pid) return null;
  const month = months.indexOf(match[2]!),
    day = Number(match[3]),
    hour = Number(match[4]),
    minute = Number(match[5]),
    second = Number(match[6]),
    year = Number(match[7]);
  if (year < 1970) return null;
  const timestamp = Date.UTC(year, month, day, hour, minute, second),
    date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    return null;
  return timestamp;
};

// 不依据 ps 的空输出或错误码判定死亡；只有内核 ESRCH 才确认 PID 不存在。
export async function darwinProcessLookup(
  pid: number,
  tools: DarwinProcessTools = defaultTools,
): Promise<ProcessLookup> {
  if (!Number.isInteger(pid) || pid < 1 || pid > 2147483647)
    return { kind: "unknown" };
  try {
    const options: ExecFileOptionsWithStringEncoding = {
      encoding: "utf8",
      env: { LC_ALL: "C", TZ: "UTC" },
      timeout: 10000,
      maxBuffer: 4096,
    };
    const [boot, processInfo] = await Promise.all([
      tools.run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], options),
      tools.run("/bin/ps", ["-p", String(pid), "-o", "pid=,lstart="], options),
    ]);
    const bootId = boot.stdout.trim().toLowerCase();
    const timestamp = startTimestamp(processInfo.stdout, pid);
    // ps 的启动时间精度为秒；同秒 PID 复用会被保守视为仍占用，不抢占旧锁。
    if (
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
        bootId,
      ) &&
      timestamp !== null
    )
      return { kind: "found", startKey: `darwin:${bootId}:${timestamp}` };
  } catch {
    // 系统工具不可用、超时或结果不完整时，仍需独立确认进程是否不存在。
  }
  try {
    tools.probe(pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ESRCH")
      return { kind: "missing" };
  }
  return { kind: "unknown" };
}
