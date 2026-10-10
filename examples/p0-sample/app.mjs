import { createServer } from "node:http";
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// 只有这两种经测试的样板源文件允许由样板执行器运行。
const includeDisplay = false;
const dataFile = process.env.FORGEX_SAMPLE_DATA_FILE;
if (!dataFile) throw new Error("缺少样板数据文件");
let appointments = [];
try {
  appointments = JSON.parse(await readFile(dataFile, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const save = async () => {
  await writeFile(`${dataFile}.tmp`, JSON.stringify(appointments), {
    mode: 0o600,
  });
  await rename(`${dataFile}.tmp`, dataFile);
};
const homepage = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>访客预约样板</title><style>body{font:16px system-ui;max-width:640px;margin:48px auto;padding:20px}label{display:grid;gap:8px;margin:20px 0}input,button{padding:12px;font:inherit}output{display:block;margin-top:20px;white-space:pre-wrap}</style><h1>访客预约</h1><p>ForgeX P0 隔离验收样板</p><form><label>访客姓名<input name="name" required minlength="2"></label><label>到访时间<input name="visitAt" type="datetime-local" required></label><button>提交预约</button></form><output aria-live="polite"></output><script>const form=document.querySelector('form');form.addEventListener('submit',async(event)=>{event.preventDefault();const result=await fetch('/appointments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:form.elements.namedItem('name').value,visitAt:form.elements.namedItem('visitAt').value,requestKey:crypto.randomUUID()})});document.querySelector('output').textContent=JSON.stringify(await result.json(),null,2);});</script></html>`;
let writes = Promise.resolve();
const server = createServer(async (request, response) => {
  const json = (status, value) => {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify(value));
  };
  try {
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
    if (request.method === "POST" && request.url === "/appointments") {
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 4096)
          return json(413, { error: "内容过大" });
      }
      const body = JSON.parse(raw);
      if (
        typeof body.name !== "string" ||
        body.name.trim().length < 2 ||
        body.name.length > 100 ||
        typeof body.visitAt !== "string" ||
        !Number.isFinite(Date.parse(body.visitAt)) ||
        typeof body.requestKey !== "string" ||
        !/^[a-f0-9-]{36}$/u.test(body.requestKey)
      )
        return json(400, { error: "请填写有效姓名、到访时间和请求标识" });
      const write = writes.then(async () => {
        const existing = appointments.find(
          (item) => item.requestKey === body.requestKey,
        );
        if (existing) {
          if (
            existing.name !== body.name.trim() ||
            existing.visitAt !== body.visitAt
          )
            return json(409, { error: "同一请求标识不能用于不同预约" });
          return json(200, existing);
        }
        const appointment = {
          id: randomUUID(),
          name: body.name.trim(),
          visitAt: body.visitAt,
          requestKey: body.requestKey,
          ...(includeDisplay ? { display: "预约已确认" } : {}),
        };
        appointments.push(appointment);
        await save();
        return json(201, appointment);
      });
      writes = write.catch(() => {});
      await write;
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/appointments/")) {
      const appointment = appointments.find(
        (item) => item.id === request.url.slice("/appointments/".length),
      );
      return appointment
        ? json(200, appointment)
        : json(404, { error: "预约不存在" });
    }
    return json(404, { error: "入口不存在" });
  } catch {
    if (!response.headersSent) json(400, { error: "请求没有完成" });
    else response.end();
  }
});
server.listen(Number(process.env.FORGEX_SAMPLE_PORT ?? 0), "127.0.0.1", () => {
  console.log(JSON.stringify({ port: server.address().port }));
});
const stop = () => server.close(() => process.exit(0));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
