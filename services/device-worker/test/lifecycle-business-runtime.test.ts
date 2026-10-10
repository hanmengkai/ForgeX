import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Server } from "node:http";
import { describe, it, expect, vi } from "vitest";

const runtimePath = new URL(
  "../../../examples/p0-sample/business-runtime.mjs",
  import.meta.url,
).href;
const businessPath = new URL(
  "./fixtures/appointment-business.txt",
  import.meta.url,
);

describe("生命周期可信业务运行时的 HTTP 与持久化（合成业务源码）", () => {
  it("真实 HTTP、并发幂等、输入错误、容量探针和重启持久化", async () => {
    const runtime = await import(runtimePath);
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-http-runtime-"));
    const servers: Server[] = [];
    const businessSource = await readFile(businessPath, "utf8");
    const dataFile = path.join(root, "appointments.json"),
      artifact = path.join(root, "artifact.json");
    try {
      await writeFile(
        artifact,
        JSON.stringify({ schemaVersion: 1, businessSource }),
      );
      vi.stubEnv("FORGEX_SAMPLE_DATA_FILE", dataFile);
      vi.stubEnv("FORGEX_SAMPLE_PORT", "0");
      vi.stubEnv("FORGEX_SAMPLE_ARTIFACT_DIGEST", "a".repeat(64));
      vi.stubEnv("FORGEX_SAMPLE_ENVIRONMENT_KEY", "合成环境");
      vi.stubEnv("FORGEX_SAMPLE_VERIFY", "1");
      const start = async () => {
        const server = (await runtime.startBusinessServer(artifact)) as Server;
        servers.push(server);
        if (!server.listening)
          await new Promise<void>((resolve) =>
            server.once("listening", resolve),
          );
        return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      };
      const close = async () => {
        const server = servers.pop()!;
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      };
      let url = await start();
      expect(await fetch(`${url}/health`).then((r) => r.json())).toMatchObject({
        healthy: true,
        artifactDigest: "a".repeat(64),
        environmentKey: "合成环境",
      });
      expect(await fetch(url).then((r) => r.text())).toContain("访客预约");
      const body = {
        name: "  测试访客  ",
        visitAt: "2000-01-01T10:00:00Z",
        requestKey: randomUUID(),
      };
      const post = (payload: unknown) =>
        fetch(`${url}/appointments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      const created = await post(body);
      expect(created.status).toBe(201);
      const appointment = await created.json();
      expect(appointment.name).toBe("测试访客");
      expect(
        await fetch(`${url}/appointments/${appointment.id}`).then((r) =>
          r.json(),
        ),
      ).toEqual(appointment);
      expect((await post({ ...body, name: "其他访客" })).status).toBe(409);
      expect((await post(null)).status).toBe(400);
      expect(
        (
          await fetch(`${url}/appointments`, {
            method: "POST",
            body: "broken-json",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(`${url}/appointments`, {
            method: "POST",
            body: "x".repeat(4100),
          })
        ).status,
      ).toBe(413);
      expect((await fetch(`${url}/unknown`)).status).toBe(404);
      const concurrent = await Promise.all(
        Array.from({ length: 4 }, () =>
          post({ ...body, requestKey: body.requestKey }),
        ),
      );
      expect(concurrent.every((r) => r.status === 200)).toBe(true);
      expect(JSON.parse(await readFile(dataFile, "utf8"))).toHaveLength(1);
      expect(
        await fetch(`${url}/__forgex_contract_probes`).then((r) => r.json()),
      ).toEqual({
        create: true,
        invalid: true,
        idempotency: true,
        query: true,
        display: false,
      });
      await close();
      url = await start();
      expect(
        await fetch(`${url}/appointments/${appointment.id}`).then((r) =>
          r.json(),
        ),
      ).toEqual(appointment);
      expect((await post(body)).status).toBe(200);
      await close();
      vi.stubEnv(
        "FORGEX_SAMPLE_DATA_FILE",
        path.join(root, "missing-directory", "appointments.json"),
      );
      url = await start();
      expect((await post({ ...body, requestKey: randomUUID() })).status).toBe(
        400,
      );
      await mkdir(path.join(root, "missing-directory"));
      expect((await post({ ...body, requestKey: randomUUID() })).status).toBe(
        201,
      );
      await close();
      await writeFile(
        artifact,
        JSON.stringify({
          schemaVersion: 1,
          businessSource:
            "function handleAppointment(){throw new Error('合成故障');}",
        }),
      );
      url = await start();
      expect((await fetch(`${url}/unknown`)).status).toBe(400);
      await close();
      expect(
        runtime.verifyBusinessContract(
          "function handleAppointment(){throw new Error('合成故障');}",
        ),
      ).toEqual({
        create: false,
        invalid: false,
        idempotency: false,
        query: false,
        display: false,
      });
      for (const source of [
        123,
        "x".repeat(65537),
        "function handleAppointment(){return undefined;}",
        "function handleAppointment(){return {status:500,body:{},appointments:[]};}",
      ]) {
        expect(() => runtime.evaluateBusiness(source, {})).toThrow();
      }
    } finally {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("缺少协议、坏制品和坏持久化文件均拒绝启动", async () => {
    const runtime = await import(runtimePath);
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-http-invalid-"));
    try {
      const artifact = path.join(root, "artifact.json"),
        data = path.join(root, "data.json");
      await writeFile(
        artifact,
        JSON.stringify({
          schemaVersion: 1,
          businessSource: "function handleAppointment(){}",
        }),
      );
      vi.stubEnv("FORGEX_SAMPLE_DATA_FILE", "");
      await expect(runtime.startBusinessServer(artifact)).rejects.toThrow(
        "协议",
      );
      vi.stubEnv("FORGEX_SAMPLE_DATA_FILE", data);
      await writeFile(data, "invalid-json");
      await expect(runtime.startBusinessServer(artifact)).rejects.toThrow();
      await writeFile(artifact, JSON.stringify({ schemaVersion: 99 }));
      await expect(runtime.startBusinessServer(artifact)).rejects.toThrow(
        "协议",
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
