# 团队任务看板项目契约 v1

这是非预约的 TypeScript 业务项目。登记源码为 `src/tasks.ts`，默认导出同步函数 `handle(input: Input): Result`。它只负责业务，HTTP、持久化、编号生成和健康接口由受信 Node 运行时管理。不得导入外部依赖、读取环境、执行命令、修改其他文件或声称已测试通过。源码最初只抛出“业务尚未实现”，实际实现由开发 Agent 完成。

`Input`：`{ schemaVersion: 1, method: string, url: string, body: unknown, state: { tasks?: Task[] }, newId: string }`。
`Task`：`{ id: string, title: string, status: "todo" | "doing" | "done", requestKey: string }`。
`Result`：`{ status: number, body: object, state: { tasks: Task[] } }`。所有响应包括当前完整状态，错误不改变原状态。中文可读错误放在 `body.error`。不使用系统时间或自己生成编号。

需求方案的验收条件必须使用下面五个标题，并保留同样含义；不支持的附加需求保留待澄清。

1. **任务创建与编号**（套件 `create`）：`POST /tasks` 接收 `{ title, requestKey }`；标题去除前后空白后长度 2–100，requestKey 为小写 UUID；成功 201，返回完整任务，编号取 newId，初始状态 todo。容量上限 1000 条，满额返回 409。
2. **输入校验与错误信息**（套件 `validation`）：空白、长度超限、非字符串标题、无效 UUID、空或数组请求返回 400 中文错误且不保存；未知路由或不存在任务返回 404 中文错误。
3. **重复提交与冲突保护**（套件 `idempotency`）：同 requestKey、同规范化标题重传返回 200 同一个任务且不新增；同 key 不同标题返回 409 中文错误且不修改任务。
4. **任务查询与状态筛选**（套件 `query`）：`GET /tasks` 返回 `{ tasks }`；`GET /tasks?status=todo|doing|done` 按状态筛选；非法状态返回 400；`GET /tasks/:id` 返回完整任务，不存在返回 404。
5. **状态流转与非法变更**（套件 `transition`）：`PATCH /tasks/:id` 接收 `{ status }`；只允许 todo→doing→done，成功 200 完整任务；设置原状态为幂等 200；跳级、逆向返回 409；非法状态返回 400；非法变更不改变原数据。

开发代码注释和 Git 提交使用简体中文。独立测试 Agent 返回计划 v2：`{ schemaVersion: 2, summary, cases: [{ criterionIndex: 0, suiteKey: "create" }, ...] }`，五条验收条件逐一绑定以上套件；没有通过标志或执行命令。开发执行器只声明实现完成，严格编译、自测及 Git 提交由可信执行器产生。

## 本轮业务澄清决议

- UUID 严格匹配小写标准连字符格式，版本位 1–8、变体位 8/9/a/b；不接受 nil、全大写、前后空白。
- 标题长度按 JavaScript 字符串 length（UTF-16 代码单元）计算，先 trim 再验证。
- POST 先验证请求格式，再核对重复键及冲突，最后核对容量；满额时同键同内容仍返回原任务，同键异内容仍返回冲突。
- body 为对象且必须包含对应必填字段；额外字段忽略，不写入任务。POST 空请求、数组或缺失字段返回 400。PATCH 在找到目标任务后验证 body，空请求、数组或缺少 status 返回 400。
- 仅处理大写 GET、POST、PATCH 和精确路由，无尾部斜杠或 URL 解码别名。未知查询参数忽略；多个 status 使用第一个值；非法 status 返回 400；没有 status 返回完整列表。不存在任务先返回 404，再判断 PATCH 内容。
- state.tasks 缺省按空数组；受信运行时提供合法的历史状态及唯一 newId。查询按创建顺序，不改变状态；错误文案要求中文可读，不要求固定字面值。
- 分页、搜索、删除、标题编辑、成员分配和用户权限属于后续版本，本次明确不纳入需求，不作为待澄清阻塞项。
- 测试交付装配已经确定：正式 PostgreSQL 控制面、独立 Worker、受信运行时和固定摘要套件；仅本机测试地址。需求方验收后等待发布审批，无生产执行器。部署方式无需再次澄清。
- 五条验收条件和本决议构成本轮完整范围；确实出现新的业务冲突才提出 openQuestions，不能把已明确的决议或后续版本功能重复列为问题。
- 业务函数只使用 ES2022 标准 JavaScript 能力（字符串、数组、对象、JSON、正则等）。没有 DOM、URL、URLSearchParams、fetch、process、Buffer、Node 内置模块或外部包。路径与查询参数使用字符串操作处理；不得用类型断言掩盖未提供的能力。TypeScript 标准库仅 ES2022。
