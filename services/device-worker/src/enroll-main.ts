import { unlink } from "node:fs/promises";
import path from "node:path";

import {
  enrollDeviceWorker,
  parseEnrollmentArguments,
  readEnrollmentTokenFile,
} from "./enrollment.js";

const readHiddenEnrollmentToken = async (): Promise<string> => {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error("非交互环境请使用 --token-file 提供私有接入码文件");
  }
  process.stdout.write("请粘贴一次性设备接入码（输入不会显示）：");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (data: Buffer) => {
      for (const byte of data) {
        if (byte === 3) {
          cleanup();
          reject(new Error("设备接入已取消"));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          if (!/^[A-Za-z0-9_-]{32,256}$/u.test(value)) {
            reject(new Error("设备接入码格式不正确"));
          } else {
            resolve(value);
          }
          return;
        }
        if (byte === 8 || byte === 127) {
          value = value.slice(0, -1);
        } else if (byte >= 32 && byte <= 126 && value.length < 256) {
          value += String.fromCharCode(byte);
        }
      }
    };
    process.stdin.on("data", onData);
  });
};

const command = parseEnrollmentArguments(process.argv.slice(2));
const configPath = command.configPath ?? process.env.FORGEX_WORKER_CONFIG;
if (!configPath) {
  throw new Error(
    "请通过 FORGEX_WORKER_CONFIG 或 --config 指定 Worker 配置文件",
  );
}
const resolvedConfigPath = path.resolve(configPath);
const enrollmentToken = command.tokenFile
  ? await readEnrollmentTokenFile(command.tokenFile)
  : await readHiddenEnrollmentToken();
await enrollDeviceWorker({
  controlPlaneUrl: command.controlPlaneUrl,
  enrollmentToken,
  configPath: resolvedConfigPath,
  identityPath:
    command.identityPath ??
    path.join(path.dirname(resolvedConfigPath), "account.identity"),
});
if (command.tokenFile) await unlink(command.tokenFile);
process.stdout.write("设备接入成功，正式连接已写入 Worker 配置。\n");
