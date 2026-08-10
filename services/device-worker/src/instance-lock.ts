import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import net, { type Server } from "node:net";
import os from "node:os";
import path from "node:path";

const listen = (server: Server, endpoint: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

const canConnect = (endpoint: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

const isAddressInUse = (error: unknown): boolean =>
  error instanceof Error &&
  (error as NodeJS.ErrnoException).code === "EADDRINUSE";

export class DeviceWorkerInstanceLock {
  readonly #server: Server;
  readonly #endpoint: string;
  #released = false;

  private constructor(server: Server, endpoint: string) {
    this.#server = server;
    this.#endpoint = endpoint;
  }

  static async acquire(identity: string): Promise<DeviceWorkerInstanceLock> {
    const digest = createHash("sha256").update(identity, "utf8").digest("hex");
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\forgex-device-worker-${digest}`
        : path.join(os.tmpdir(), `forgex-device-worker-${digest}.sock`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const server = net.createServer((socket) => socket.destroy());
      try {
        await listen(server, endpoint);
        return new DeviceWorkerInstanceLock(server, endpoint);
      } catch (error) {
        server.close();
        if (!isAddressInUse(error)) throw error;
        if (await canConnect(endpoint)) {
          throw new Error("同一 Codex 设备账户已经有一个 Worker 实例在运行");
        }
        if (process.platform === "win32") {
          throw new Error("设备 Worker 命名管道被占用，无法确认单实例状态");
        }
        try {
          await unlink(endpoint);
        } catch (unlinkError) {
          if (!(
            unlinkError instanceof Error &&
            (unlinkError as NodeJS.ErrnoException).code === "ENOENT"
          )) {
            throw unlinkError;
          }
        }
      }
    }
    throw new Error("设备 Worker 无法取得单实例执行锁");
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    await close(this.#server);
    if (process.platform !== "win32") {
      try {
        await unlink(this.#endpoint);
      } catch (error) {
        if (!(
          error instanceof Error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        )) {
          throw error;
        }
      }
    }
  }
}

export const uniqueLockIdentityForTest = (): string => randomUUID();
