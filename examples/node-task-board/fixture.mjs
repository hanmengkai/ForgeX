// 仅用于明确标注的持续集成回归，实时验收不会读取或写入这份业务实现。
export const fixtureSource = `
type Task = { id: string; title: string; status: 'todo' | 'doing' | 'done'; requestKey: string };
type Input = { method: string; url: string; body: unknown; state: { tasks?: Task[] }; newId: string };
export default function handle(input: Input): { status: number; body: object; state: { tasks: Task[] } } {
  const tasks = (input.state.tasks ?? []).map(t => ({ ...t }));
  const result = (status: number, body: object) => ({ status, body, state: { tasks } });
  const error = (status: number, message: string) => result(status, { error: message });
  const [route, query] = input.url.split('?');
  const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body) ? input.body as Record<string, unknown> : null;
  if (input.method === 'POST' && route === '/tasks') {
    if (!body || typeof body.title !== 'string' || body.title.trim().length < 2 || body.title.trim().length > 100 || typeof body.requestKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.requestKey)) return error(400, '请填写有效标题和请求编号');
    const title = body.title.trim(), old = tasks.find(t => t.requestKey === body.requestKey);
    if (old) return old.title === title ? result(200, old) : error(409, '重复请求内容冲突');
    if (tasks.length >= 1000) return error(409, '任务数量已达上限');
    const task: Task = { id: input.newId, title, requestKey: body.requestKey, status: 'todo' }; tasks.push(task); return result(201, task);
  }
  if (input.method === 'GET' && route === '/tasks') {
    const status = query?.split('&').find(p => p.startsWith('status='))?.slice(7);
    if (status !== undefined && !['todo', 'doing', 'done'].includes(status)) return error(400, '任务状态不正确');
    return result(200, { tasks: status === undefined ? tasks : tasks.filter(t => t.status === status) });
  }
  if (route?.startsWith('/tasks/')) {
    const task = tasks.find(t => t.id === route.slice(7)); if (!task) return error(404, '没有找到任务');
    if (input.method === 'GET') return result(200, task);
    if (input.method === 'PATCH') {
      if (!body || typeof body.status !== 'string' || !['todo', 'doing', 'done'].includes(body.status)) return error(400, '任务状态不正确');
      if (task.status === body.status) return result(200, task);
      if (!((task.status === 'todo' && body.status === 'doing') || (task.status === 'doing' && body.status === 'done'))) return error(409, '不能跳过或逆转任务状态');
      task.status = body.status as Task['status']; return result(200, task);
    }
  }
  return error(404, '没有找到业务入口');
}
`;
export function fixtureResponse(stage, catalog) {
  if (stage === "requirements_ai")
    return {
      kind: "requirements",
      summary: "显式 fixture：团队任务管理方案",
      spec: {
        schemaVersion: 1,
        title: "团队任务管理",
        goal: "创建查询和流转团队任务",
        userStories: [],
        acceptanceCriteria: catalog.map((c) => ({
          title: c.title,
          description: "按照登记项目契约验收：" + c.title,
          priority: "must",
        })),
        openQuestions: [],
      },
    };
  if (stage === "design_ai")
    return {
      kind: "design",
      summary: "显式 fixture：受控 TypeScript 处理模块",
      architecture: "独立 TypeScript 模块实现业务，可信运行时管理 HTTP 与状态",
      interfaces: ["POST /tasks", "GET /tasks", "PATCH /tasks/:id"],
      migrations: ["版本化任务状态"],
      testStrategy: ["独立 HTTP 套件覆盖五条条件"],
      rolloutPlan: "仅部署测试环境",
    };
  if (stage === "testing")
    return {
      schemaVersion: 2,
      summary: "显式 fixture：独立套件映射",
      cases: catalog.map((c, criterionIndex) => ({
        criterionIndex,
        suiteKey: c.suiteKey,
      })),
    };
  return {
    status: "completed",
    summary: "显式 fixture：实现完成，测试由可信执行器执行",
  };
}
