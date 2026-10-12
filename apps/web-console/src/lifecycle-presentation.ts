import {
  lifecycleStageLabels,
  type LifecycleRole,
  type LifecycleStage,
  type LifecycleView,
} from "@forgex/contracts/lifecycle";
export const lifecycleRoleNames: Record<LifecycleRole, string> = {
  requester: "需求方",
  product_owner: "产品负责人",
  requirement_analyst: "需求分析师",
  developer: "研发负责人",
  tester: "测试负责人",
  test_ops: "测试运维",
  production_ops: "生产运维",
  administrator: "平台管理员",
};
export const lifecyclePhases: { label: string; stages: LifecycleStage[] }[] = [
  {
    label: "需求",
    stages: [
      "requirements_ai",
      "requirements_review",
      "requester_confirmation",
    ],
  },
  { label: "设计", stages: ["design_ai", "design_review"] },
  { label: "开发", stages: ["development", "code_review"] },
  { label: "测试", stages: ["testing", "test_review"] },
  {
    label: "发布",
    stages: [
      "staging_deploy",
      "staging_acceptance",
      "release_approval",
      "production_deploy",
      "recovery_approval",
      "production_rollback",
    ],
  },
  { label: "验收", stages: ["online_acceptance", "closed"] },
];
const next: Record<LifecycleStage, string> = {
  requirements_ai: "需求 AI 正在整理方案，完成后交由产品审核",
  requirements_review: "由产品负责人审核需求方案",
  requester_confirmation: "由需求方确认需求和验收标准",
  design_ai: "设计 AI 正在生成方案，完成后交由研发独立审核",
  design_review: "由研发负责人独立审核设计方案",
  development: "开发 AI 正在实现已批准设计并执行自测",
  code_review: "由研发负责人审核代码与自测结果",
  testing: "独立测试执行器验证已审核制品",
  test_review: "由测试负责人审核独立测试报告",
  staging_deploy: "测试运维执行器部署已验证制品",
  staging_acceptance: "由需求方打开测试环境完成验收",
  release_approval: "由研发、生产运维和需求方分别确认发布",
  production_deploy: "运维执行器执行已批准的发布任务",
  online_acceptance: "由研发、生产运维和需求方分别完成线上验收",
  closed: "交付已完成；发现后续问题可提交关联 Bug",
  recovery_approval: "由研发、生产运维和需求方共同确认恢复方案",
  production_rollback: "运维执行器恢复已批准的上一制品",
};
export const lifecycleNextStep = (flow: LifecycleView) =>
  flow.blockedReason
    ? "核对阻塞原因和执行记录，由负责人确认后恢复"
    : next[flow.stage];
export const lifecycleActionLabel = (flow: LifecycleView) =>
  ({
    design_review: "审核设计",
    requirements_review: "审核需求",
    requester_confirmation: "确认需求",
    code_review: "审核代码",
    test_review: "审核测试",
    staging_acceptance: "验收测试环境",
    release_approval: "确认发布",
    online_acceptance: "完成线上验收",
    recovery_approval: "审核恢复",
  })[flow.stage as "design_review"] ??
  (flow.blockedReason ? "处理阻塞" : "查看交付");
export const needsLifecycleAction = (flow: LifecycleView) =>
  flow.allowedRoles.length > 0 || flow.allowedActions.length > 0;
export const lifecycleArtifactNames: Record<string, string> = {
  requirements: "需求方案",
  design: "设计方案",
  code: "代码与自测",
  tests: "独立测试报告",
  deployment: "环境部署",
  rollback: "生产恢复",
};
export function reviewArtifactKind(stage: LifecycleStage) {
  return stage.startsWith("requirements") || stage === "requester_confirmation"
    ? "requirements"
    : stage.startsWith("design")
      ? "design"
      : stage.startsWith("development") || stage === "code_review"
        ? "code"
        : stage === "testing" || stage === "test_review"
          ? "tests"
          : "deployment";
}
export const stageName = (stage: LifecycleStage) => lifecycleStageLabels[stage];
