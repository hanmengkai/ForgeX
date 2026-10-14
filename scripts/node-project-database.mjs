import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:net";
import { savePrivateJson } from "../services/device-worker/dist/lifecycle-transfer.js";
const run = promisify(execFile);
const root = path.resolve(".forgex-local/node-p0-tools"),
  data = path.join(root, "data"),
  sockets = path.join(root, "socket"),
  connectionFile = path.join(root, "connection.json");
const bin = await realpath(
  process.env.FORGEX_POSTGRES_BIN || path.join(root, "postgres/bin"),
);
const command = process.argv[2] ?? "start";
if (!["start", "stop"].includes(command))
  throw new Error("请使用 start 或 stop 管理本项目隔离数据库");
await mkdir(sockets, { recursive: true, mode: 0o700 });
let initialized = true;
try {
  await access(path.join(data, "PG_VERSION"));
} catch {
  initialized = false;
}
if (command === "stop") {
  if (initialized)
    await run(path.join(bin, "pg_ctl"), [
      "-D",
      data,
      "-m",
      "fast",
      "-w",
      "stop",
    ]);
  console.log("任务管理隔离数据库已停止，交付记录保留");
} else {
  if (!initialized)
    await run(path.join(bin, "initdb"), [
      "-D",
      data,
      "-A",
      "trust",
      "--no-locale",
      "--encoding=UTF8",
    ]);
  let url;
  try {
    url = new URL(
      JSON.parse(await readFile(connectionFile, "utf8")).connectionString,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (
    url &&
    (url.hostname !== "127.0.0.1" ||
      url.pathname !== "/forgex_node_test" ||
      !url.port)
  )
    throw new Error("已有隔离数据库连接不符合本项目范围");
  if (!url) {
    const server = createServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    await new Promise((r) => server.close(r));
    url = new URL(
      `postgresql://${encodeURIComponent(os.userInfo().username)}@127.0.0.1:${port}/forgex_node_test`,
    );
  }
  let running = false;
  try {
    await run(path.join(bin, "pg_ctl"), ["-D", data, "status"]);
    running = true;
  } catch {}
  if (!running)
    await run(path.join(bin, "pg_ctl"), [
      "-D",
      data,
      "-l",
      path.join(root, "postgres.log"),
      "-o",
      `-h 127.0.0.1 -p ${Number(url.port)} -k ${sockets}`,
      "-w",
      "start",
    ]);
  const exists = await run(path.join(bin, "psql"), [
    "-h",
    "127.0.0.1",
    "-p",
    url.port,
    "-d",
    "postgres",
    "-Atc",
    "SELECT 1 FROM pg_database WHERE datname='forgex_node_test'",
  ]);
  if (exists.stdout.trim() !== "1")
    await run(path.join(bin, "createdb"), [
      "-h",
      "127.0.0.1",
      "-p",
      url.port,
      "forgex_node_test",
    ]);
  await savePrivateJson(connectionFile, { connectionString: url.href });
  console.log("任务管理隔离 PostgreSQL 已就绪，连接信息只保存在本地私有文件");
}
