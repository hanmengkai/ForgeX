# ADR-0005：只有已确认需求可以通过 outbox 开始交付

## 状态

已接受。

## 决策

公开 API 不接受调用方自报的需求标题、项目范围或需求版本。产品负责人只能沿需求详情返回的 `startDelivery` action 提交所需设备能力；服务端从当前租户和项目的权威需求聚合读取标题与版本，并要求该版本已经确认。

开始交付与写入 `DeliveryDispatchRecord` outbox 在同一个需求仓储事务完成。派发器把 outbox 幂等写入租户级设备队列，再回写派发时间和审计事件。若进程在两次事务之间退出，后续任一项目入口收到合法 Worker 轮询时，都会按租户跨项目扫描 pending outbox；重复派发由 `projectKey + requirementKey + requirementRevision` 唯一语义吸收。

## 项目边界

Codex 账户舰队属于租户且不设置固定产品数量上限，设备可以领取租户内不同项目的任务。每份队列任务、租约、完成记录都必须携带 `projectKey` 和 `requirementRevision`，Worker 不能把另一个项目或旧版本当作当前交付。

## 原因

- 防止绕过需求确认流程，用任意 UUID 或伪造标题启动交付。
- 防止需求修改后，Worker 继续执行未经确认的旧版本。
- 在需求仓储和设备仓储分离时，用可重试 outbox 避免“需求已进入交付但任务永久丢失”。

## 后果

- `/api/v1/delivery-requests` 不存在；开始交付使用需求资源下的 action。
- outbox 派发采用至少一次执行，设备队列必须提供同一版本的幂等入队。
- 生产 requirement repository 必须由同一租户的项目入口共享，并与需求状态一起持久化 outbox；只保存设备队列不足以恢复完整流程。
