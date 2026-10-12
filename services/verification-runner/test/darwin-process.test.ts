import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  darwinProcessLookup,
  type DarwinProcessTools,
} from "../src/darwin-process.js";

const boot = "00000000-0000-4000-8000-000000000001";
const knownStart = "123 Mon Oct 12 02:00:00 2026\n";
const tools = (
  stdout = knownStart,
  uuid = boot,
  probe: DarwinProcessTools["probe"] = () => {},
): DarwinProcessTools => ({
  run: async (command, args, options) => {
    expect(["/usr/sbin/sysctl", "/bin/ps"]).toContain(command);
    expect(options.env).toEqual({ LC_ALL: "C", TZ: "UTC" });
    if (command === "/usr/sbin/sysctl") {
      expect(args).toEqual(["-n", "kern.bootsessionuuid"]);
      return { stdout: uuid };
    }
    expect(args).toEqual(["-p", "123", "-o", "pid=,lstart="]);
    return { stdout };
  },
  probe,
});
describe("macOS 进程启动身份查询", () => {
  it("启动会话与 UTC 时间共同构成稳定身份，系统重启及 PID 复用改变身份", async () => {
    const first = await darwinProcessLookup(123, tools());
    expect(first).toEqual({
      kind: "found",
      startKey: `darwin:${boot}:1791770400000`,
    });
    expect(
      await darwinProcessLookup(
        123,
        tools(knownStart, "00000000-0000-4000-8000-000000000002"),
      ),
    ).not.toEqual(first);
    expect(
      await darwinProcessLookup(123, tools("123 Mon Oct 12 02:00:01 2026\n")),
    ).not.toEqual(first);
  });
  it("空、错误 PID、无效日期、额外行或坏启动会话均返回未知，不伪造进程退出", async () => {
    for (const output of [
      "",
      "124 Mon Oct 12 02:00:00 2026",
      "123 Mon Feb 30 02:00:00 2026",
      "123 Mon Oct 12 25:00:00 2026",
      knownStart + knownStart,
      "bad-response",
    ]) {
      expect(await darwinProcessLookup(123, tools(output))).toEqual({
        kind: "unknown",
      });
    }
    expect(
      await darwinProcessLookup(123, tools(knownStart, "not-a-uuid")),
    ).toEqual({ kind: "unknown" });
  });
  it("仅 ESRCH 确认不存在；查询失败、权限错误及超时保守返回未知", async () => {
    const unavailable: DarwinProcessTools = {
      run: async () => {
        throw new Error("系统查询失败");
      },
      probe: () => {},
    };
    expect(await darwinProcessLookup(123, unavailable)).toEqual({
      kind: "unknown",
    });
    for (const code of ["EPERM", "ETIMEDOUT", "ENOENT"]) {
      expect(
        await darwinProcessLookup(123, {
          ...unavailable,
          probe: () => {
            throw Object.assign(new Error("探测失败"), { code });
          },
        }),
      ).toEqual({ kind: "unknown" });
    }
    expect(
      await darwinProcessLookup(123, {
        ...unavailable,
        probe: () => {
          throw Object.assign(new Error("进程不存在"), { code: "ESRCH" });
        },
      }),
    ).toEqual({ kind: "missing" });
    for (const pid of [0, -1, 1.5, 2147483648, NaN]) {
      let calls = 0;
      expect(
        await darwinProcessLookup(pid, {
          run: async () => {
            calls++;
            throw new Error("非法 PID 不应调用系统");
          },
          probe: () => {
            calls++;
            throw new Error("非法 PID 不应探测");
          },
        }),
      ).toEqual({ kind: "unknown" });
      expect(calls).toBe(0);
    }
  });
});
describe.skipIf(process.platform !== "darwin")("macOS 实际进程身份", () => {
  it("能识别当前控制器及真实子进程，子进程退出后确认不存在", async () => {
    expect(await darwinProcessLookup(process.pid)).toMatchObject({
      kind: "found",
      startKey: expect.stringMatching(/^darwin:[a-f0-9-]{36}:\d+$/),
    });
    const child = spawn(
      process.execPath,
      ["-e", "console.log('ready');setInterval(()=>{},1000)"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      await once(child.stdout!, "data");
      const pid = child.pid!;
      expect(await darwinProcessLookup(pid)).toMatchObject({ kind: "found" });
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      await exit;
      expect(await darwinProcessLookup(pid)).toEqual({ kind: "missing" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGTERM");
        await exit;
      }
    }
  });
});
