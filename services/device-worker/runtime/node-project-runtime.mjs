import vm from "node:vm";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// 运行时持有 HTTP 和存储；候选模块只接收序列化业务输入。
export function evaluateNodeProject(bundle, input) {
  if (
    bundle?.schemaVersion !== 2 ||
    !bundle.modules ||
    typeof bundle.modules !== "object" ||
    !Object.hasOwn(bundle.modules, bundle.entrypoint)
  )
    throw new Error("Node 项目制品协议不正确");
  const files = Object.entries(bundle.modules);
  if (
    !files.length ||
    files.length > 100 ||
    Buffer.byteLength(JSON.stringify(bundle)) > 128 * 1024 ||
    files.some(
      ([name, source]) =>
        !/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.js$/u.test(name) ||
        typeof source !== "string",
    )
  )
    throw new Error("Node 项目模块清单不正确");
  const definitions = files
    .map(
      ([name, source]) =>
        `definitions[${JSON.stringify(name)}] = function(module, exports, require) {\n${source}\n};`,
    )
    .join("\n");
  const context = vm.createContext(
    Object.assign(Object.create(null), { inputJson: JSON.stringify(input) }),
    {
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: "afterEvaluate",
    },
  );
  const script = new vm.Script(`"use strict";
    const definitions = Object.create(null), cache = Object.create(null);
    ${definitions}
    function load(name) {
      if (!Object.hasOwn(definitions, name)) throw new Error("模块没有登记");
      if (cache[name]) return cache[name].exports;
      const module = { exports: {} }; cache[name] = module;
      definitions[name](module, module.exports, function(relative) {
        if (typeof relative !== "string" || !relative.startsWith(".")) throw new Error("外部模块未授权");
        const parts = name.split("/"); parts.pop();
        for (const p of relative.split("/")) { if (p === ".") continue; if (p === "..") { if (!parts.length) throw new Error("模块越界"); parts.pop(); } else parts.push(p); }
        let target = parts.join("/"); if (!target.endsWith(".js")) target += ".js";
        return load(target);
      });
      return module.exports;
    }
    const handler = load(${JSON.stringify(bundle.entrypoint)}).default;
    if (typeof handler !== "function") throw new Error("业务入口必须默认导出函数");
    JSON.stringify(handler(JSON.parse(inputJson)));
  `);
  const raw = script.runInContext(context, { timeout: 100 });
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 1024 * 1024)
    throw new Error("业务结果大小或同步协议不正确");
  const result = JSON.parse(raw);
  if (
    !result ||
    !Number.isInteger(result.status) ||
    result.status < 200 ||
    result.status > 499 ||
    result.status === 204 ||
    !result.body ||
    typeof result.body !== "object" ||
    !result.state ||
    typeof result.state !== "object" ||
    Array.isArray(result.state)
  )
    throw new Error("业务结果结构不正确");
  return result;
}

async function serve(file) {
  const bytes = await readFile(file),
    bundle = JSON.parse(bytes.toString("utf8"));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== process.env.FORGEX_PROJECT_ARTIFACT_DIGEST)
    throw new Error("Node 项目制品摘要不正确");
  const dataFile = process.env.FORGEX_PROJECT_DATA_FILE;
  if (!dataFile) throw new Error("Node 项目缺少受信存储路径");
  let state = {};
  try {
    const saved = JSON.parse(await readFile(dataFile, "utf8"));
    if (
      saved.schemaVersion !== 1 ||
      !saved.state ||
      typeof saved.state !== "object" ||
      Array.isArray(saved.state)
    )
      throw new Error("Node 项目持久数据损坏");
    state = saved.state;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let queue = Promise.resolve();
  const server = createServer((req, res) => {
    queue = queue
      .then(async () => {
        try {
          if (req.url === "/health" && req.method === "GET") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                healthy: true,
                artifactDigest: digest,
                environmentKey: process.env.FORGEX_PROJECT_ENVIRONMENT_KEY,
              }),
            );
            return;
          }
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 64 * 1024) {
              res.writeHead(413);
              res.end();
              return;
            }
            chunks.push(chunk);
          }
          let body = null;
          try {
            if (size) body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "请求内容必须是有效 JSON" }));
            return;
          }
          const result = evaluateNodeProject(bundle, {
            schemaVersion: 1,
            method: req.method,
            url: req.url,
            body,
            state,
            newId: randomUUID(),
          });
          if (JSON.stringify(result.state) !== JSON.stringify(state)) {
            const temporary = `${dataFile}.${randomUUID()}.tmp`;
            await writeFile(
              temporary,
              JSON.stringify({ schemaVersion: 1, state: result.state }),
              { mode: 0o600 },
            );
            await rename(temporary, dataFile);
            state = result.state;
          }
          res.writeHead(result.status, { "content-type": "application/json" });
          res.end(JSON.stringify(result.body));
        } catch {
          if (!res.headersSent)
            res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "业务执行失败，请核对测试证据" }));
        }
      })
      .catch(() => {
        res.destroy();
      });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  console.log(JSON.stringify({ port: server.address().port }));
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await serve(process.argv[2]);
