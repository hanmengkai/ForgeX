import vm from "node:vm";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

// VM 限制业务能力；系统沙箱及 Node 权限提供进程边界，VM 本身不是安全边界。
export function evaluateBusiness(source, input) {
  if (typeof source !== "string" || Buffer.byteLength(source) > 64 * 1024)
    throw new Error("业务代码大小不符合协议");
  const context = vm.createContext(
    Object.assign(Object.create(null), { __input: JSON.stringify(input) }),
    {
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: "afterEvaluate",
    },
  );
  const script = new vm.Script(
    `"use strict";\n${source}\n;JSON.stringify(handleAppointment(JSON.parse(__input)));`,
  );
  const raw = script.runInContext(context, { timeout: 100 });
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 1024 * 1024)
    throw new Error("业务结果格式不符合协议");
  const result = JSON.parse(raw);
  if (
    !result ||
    !Number.isInteger(result.status) ||
    ![200, 201, 400, 404, 409].includes(result.status) ||
    !result.body ||
    typeof result.body !== "object" ||
    Array.isArray(result.body) ||
    !Array.isArray(result.appointments) ||
    result.appointments.length > 2000
  )
    throw new Error("业务结果不符合协议");
  return result;
}

// 固定探针验证协议边界，测试结果始终来自候选代码的实际执行。
export function verifyBusinessContract(source) {
  const id = randomUUID(),
    key = randomUUID();
  const payload = {
    name: "  验收访客  ",
    visitAt: "2000-01-01T10:00:00Z",
    requestKey: key,
  };
  const invoke = (method, url, body, appointments = []) =>
    evaluateBusiness(source, { method, url, body, appointments, newId: id });
  const same = isDeepStrictEqual;
  const groups = Object.fromEntries(
    ["create", "invalid", "idempotency", "query", "display"].map((name) => [
      name,
      false,
    ]),
  );
  try {
    const created = invoke("POST", "/appointments", payload);
    const record = created.body;
    const lower = invoke("POST", "/appointments", {
      ...payload,
      name: "甲乙",
      requestKey: randomUUID(),
    });
    const upper = invoke("POST", "/appointments", {
      ...payload,
      name: "甲".repeat(100),
      requestKey: randomUUID(),
    });
    groups.create =
      created.status === 201 &&
      record.id === id &&
      record.name === "验收访客" &&
      record.visitAt === payload.visitAt &&
      record.requestKey === key &&
      created.appointments.length === 1 &&
      same(created.appointments[0], {
        id: record.id,
        name: record.name,
        visitAt: record.visitAt,
        requestKey: record.requestKey,
      }) &&
      lower.status === 201 &&
      upper.status === 201;
    const records = created.appointments;
    const invalidBodies = [
      null,
      [],
      {},
      { ...payload, name: 1 },
      { ...payload, name: " " },
      { ...payload, name: "甲" },
      { ...payload, name: "甲".repeat(101) },
      { ...payload, visitAt: 1 },
      { ...payload, visitAt: "无效" },
      { ...payload, requestKey: "invalid" },
      { ...payload, requestKey: key.toUpperCase() },
      { ...payload, requestKey: ` ${key}` },
    ];
    groups.invalid = invalidBodies.every((body) => {
      const result = invoke("POST", "/appointments", body, records);
      return (
        result.status === 400 &&
        typeof result.body.error === "string" &&
        /[^\x00-\x7F]/u.test(result.body.error) &&
        same(result.appointments, records)
      );
    });
    const repeated = invoke(
      "POST",
      "/appointments",
      { ...payload, name: "验收访客" },
      records,
    );
    const conflict = invoke(
      "POST",
      "/appointments",
      { ...payload, name: "其他访客" },
      records,
    );
    const timeConflict = invoke(
      "POST",
      "/appointments",
      { ...payload, visitAt: "2000-01-01T10:00:00.000Z" },
      records,
    );
    const full = Array.from({ length: 2000 }, (_, i) => ({
      ...record,
      id: randomUUID(),
      requestKey: i === 0 ? key : randomUUID(),
    }));
    const capacity = invoke(
      "POST",
      "/appointments",
      { ...payload, requestKey: randomUUID() },
      full,
    );
    const fullRepeat = invoke("POST", "/appointments", payload, full);
    groups.idempotency =
      repeated.status === 200 &&
      same(repeated.body, record) &&
      same(repeated.appointments, records) &&
      conflict.status === 409 &&
      timeConflict.status === 409 &&
      same(conflict.appointments, records) &&
      capacity.status === 400 &&
      same(capacity.appointments, full) &&
      fullRepeat.status === 200;
    const found = invoke("GET", `/appointments/${id}`, null, records);
    const absent = [
      `/appointments/${randomUUID()}`,
      `/appointments/${id}?x=1`,
      `/appointments/${id}/`,
      `/appointments/%${id}`,
      "/unknown",
    ].map((url) => invoke("GET", url, null, records));
    absent.push(invoke("DELETE", `/appointments/${id}`, null, records));
    groups.query =
      found.status === 200 &&
      same(found.body, record) &&
      same(found.appointments, records) &&
      absent.every(
        (result) =>
          result.status === 404 &&
          typeof result.body.error === "string" &&
          same(result.appointments, records),
      );
    groups.display =
      record.display === "预约已确认" &&
      repeated.body.display === "预约已确认" &&
      found.body.display === "预约已确认" &&
      !Object.hasOwn(created.appointments[0], "display");
  } catch {}
  return groups;
}

export async function startBusinessServer(artifactPath) {
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  const dataFile = process.env.FORGEX_SAMPLE_DATA_FILE;
  if (
    !dataFile ||
    artifact.schemaVersion !== 1 ||
    typeof artifact.businessSource !== "string"
  )
    throw new Error("缺少可信样板协议");
  let appointments = [];
  try {
    appointments = JSON.parse(await readFile(dataFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let writes = Promise.resolve();
  const homepage = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 访客预约</title><style>body{font:16px system-ui;max-width:640px;margin:48px auto;padding:20px}label{display:grid;gap:8px;margin:20px 0}input,button{padding:12px;font:inherit}output{display:block;margin-top:20px;white-space:pre-wrap}</style><h1>访客预约</h1><p>真实 Agent 隔离样板</p><form><label>访客姓名<input name="name" required minlength="2"></label><label>到访时间<input name="visitAt" type="datetime-local" required></label><button>提交预约</button></form><output aria-live="polite"></output><script>const form=document.querySelector('form');form.addEventListener('submit',async(event)=>{event.preventDefault();const response=await fetch('/appointments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:form.elements.namedItem('name').value,visitAt:form.elements.namedItem('visitAt').value,requestKey:crypto.randomUUID()})});document.querySelector('output').textContent=JSON.stringify(await response.json(),null,2);});</script></html>`;
  const server = createServer(async (request, response) => {
    const json = (status, body) => {
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(body));
    };
    try {
      if (
        process.env.FORGEX_SAMPLE_VERIFY === "1" &&
        request.method === "GET" &&
        request.url === "/__forgex_contract_probes"
      )
        return json(200, verifyBusinessContract(artifact.businessSource));
      if (request.method === "GET" && request.url === "/health")
        return json(200, {
          healthy: true,
          artifactDigest: process.env.FORGEX_SAMPLE_ARTIFACT_DIGEST,
          environmentKey: process.env.FORGEX_SAMPLE_ENVIRONMENT_KEY,
        });
      if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return response.end(homepage);
      }
      let body = null;
      if (request.method === "POST") {
        let raw = "";
        for await (const chunk of request) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 4096)
            return json(413, { error: "内容过大" });
        }
        try {
          body = JSON.parse(raw);
        } catch {
          return json(400, { error: "请求格式错误" });
        }
      }
      const task = async () => {
        const result = evaluateBusiness(artifact.businessSource, {
          method: request.method,
          url: request.url,
          body,
          appointments,
          newId: randomUUID(),
        });
        if (request.method === "POST" && result.status === 201) {
          await writeFile(
            `${dataFile}.tmp`,
            JSON.stringify(result.appointments),
            { mode: 0o600 },
          );
          await rename(`${dataFile}.tmp`, dataFile);
          appointments = result.appointments;
        }
        return json(result.status, result.body);
      };
      if (request.method === "POST") {
        const pending = writes.then(task);
        writes = pending.catch(() => {});
        await pending;
      } else await task();
    } catch {
      if (!response.headersSent) json(400, { error: "业务执行失败" });
      else response.end();
    }
  });
  server.listen(Number(process.env.FORGEX_SAMPLE_PORT ?? 0), "127.0.0.1", () =>
    console.log(JSON.stringify({ port: server.address().port })),
  );
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  server.once("close", () => {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await startBusinessServer(process.argv[2]);
