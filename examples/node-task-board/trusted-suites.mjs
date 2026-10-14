import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export const catalog = [
  { title: "任务创建与编号", suiteKey: "create" },
  { title: "输入校验与错误信息", suiteKey: "validation" },
  { title: "重复提交与冲突保护", suiteKey: "idempotency" },
  { title: "任务查询与状态筛选", suiteKey: "query" },
  { title: "状态流转与非法变更", suiteKey: "transition" },
];
export async function runSuite(key, origin) {
  const checks = [];
  const check = async (name, action) => {
    try {
      await action();
      checks.push({ name, passed: true });
    } catch {
      checks.push({ name, passed: false });
    }
  };
  const request = async (method, route, body) => {
    const response = await fetch(origin + route, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(3000),
    });
    return { status: response.status, body: await response.json() };
  };
  const create = (title = "验收任务", requestKey = randomUUID()) =>
    request("POST", "/tasks", { title, requestKey });
  const chinese = (r, status) => {
    assert.equal(r.status, status);
    assert.equal(typeof r.body.error, "string");
    assert.match(r.body.error, /[^\x00-\x7F]/u);
  };
  if (key === "create") {
    await check("创建、默认状态及 UUID", async () => {
      const r = await create("  团队任务  ");
      assert.equal(r.status, 201);
      assert.equal(r.body.title, "团队任务");
      assert.equal(r.body.status, "todo");
      assert.match(r.body.id, /^[a-f0-9-]{36}$/u);
    });
    for (const title of ["甲乙", "甲".repeat(100)])
      await check("标题长度边界", async () =>
        assert.equal((await create(title)).status, 201),
      );
  } else if (key === "validation") {
    const before = (await request("GET", "/tasks")).body;
    for (const body of [
      null,
      [],
      {},
      { title: " ", requestKey: randomUUID() },
      { title: "甲", requestKey: randomUUID() },
      { title: "甲".repeat(101), requestKey: randomUUID() },
      { title: 7, requestKey: randomUUID() },
      { title: "非法编号", requestKey: "wrong" },
      { title: "非法编号", requestKey: randomUUID().toUpperCase() },
    ])
      await check("非法创建返回中文错误且不写入", async () => {
        chinese(await request("POST", "/tasks", body), 400);
        assert.deepEqual((await request("GET", "/tasks")).body, before);
      });
    await check("未知路由和任务", async () => {
      chinese(await request("GET", "/unknown"), 404);
      chinese(await request("GET", "/tasks/" + randomUUID()), 404);
    });
  } else if (key === "idempotency") {
    await check("同键同内容重试及冲突拒绝", async () => {
      const requestKey = randomUUID(),
        first = await create(" 重试任务 ", requestKey);
      const before = (await request("GET", "/tasks")).body;
      const retry = await create("重试任务", requestKey);
      assert.equal(retry.status, 200);
      assert.deepEqual(retry.body, first.body);
      chinese(await create("不同任务", requestKey), 409);
      assert.deepEqual((await request("GET", "/tasks")).body, before);
    });
  } else if (key === "query") {
    await check("列表、详情和状态筛选", async () => {
      const task = (await create("查询任务")).body;
      const list = (await request("GET", "/tasks")).body.tasks;
      assert.ok(list.some((t) => t.id === task.id));
      assert.deepEqual((await request("GET", "/tasks/" + task.id)).body, task);
      assert.ok(
        (await request("GET", "/tasks?status=todo")).body.tasks.every(
          (t) => t.status === "todo",
        ),
      );
      assert.deepEqual(
        (await request("GET", "/tasks?status=done")).body.tasks,
        [],
      );
      chinese(await request("GET", "/tasks?status=wrong"), 400);
    });
  } else if (key === "transition") {
    await check("合法流转、幂等、跳级和逆向保护", async () => {
      const task = (await create("流转任务")).body,
        url = "/tasks/" + task.id;
      chinese(await request("PATCH", url, { status: "done" }), 409);
      assert.equal((await request("GET", url)).body.status, "todo");
      chinese(await request("PATCH", url, { status: "wrong" }), 400);
      chinese(await request("PATCH", url, []), 400);
      assert.equal(
        (await request("PATCH", url, { status: "doing" })).body.status,
        "doing",
      );
      assert.equal(
        (await request("PATCH", url, { status: "doing" })).status,
        200,
      );
      assert.equal(
        (await request("PATCH", url, { status: "done" })).body.status,
        "done",
      );
      chinese(await request("PATCH", url, { status: "todo" }), 409);
      assert.equal((await request("GET", url)).body.status, "done");
    });
  } else throw new Error("未登记独立测试套件");
  return checks;
}
