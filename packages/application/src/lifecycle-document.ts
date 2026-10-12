import {
  LifecycleDocumentSchema,
  type LifecycleOutput,
} from "@forgex/contracts/lifecycle";
import type { z } from "zod";
type Section = z.infer<typeof LifecycleDocumentSchema>["sections"][number];
const sections = (output: LifecycleOutput): Section[] =>
  output.kind === "design"
    ? [
        { title: "架构设计", paragraphs: [output.architecture], items: [] },
        { title: "接口约定", paragraphs: [], items: output.interfaces },
        { title: "数据变更", paragraphs: [], items: output.migrations },
        { title: "测试策略", paragraphs: [], items: output.testStrategy },
        { title: "发布与恢复", paragraphs: [output.rolloutPlan], items: [] },
      ]
    : output.kind === "requirements"
      ? [
          { title: "业务目标", paragraphs: [output.spec.goal], items: [] },
          {
            title: "用户故事",
            paragraphs: [],
            items: output.spec.userStories.map(
              (s) => `${s.role}需要${s.need}，以便${s.value}`,
            ),
          },
          {
            title: "验收标准",
            paragraphs: [],
            items: output.spec.acceptanceCriteria.map(
              (c) => `${c.title}：${c.description}`,
            ),
          },
          {
            title: "待澄清问题",
            paragraphs: [],
            items: output.spec.openQuestions,
          },
        ]
      : [];
export function lifecycleDocument(
  output: LifecycleOutput,
  previous: LifecycleOutput | undefined,
) {
  if (!["design", "requirements"].includes(output.kind)) return undefined;
  const current = sections(output),
    old = previous ? sections(previous) : [],
    lines = (list: Section[]) =>
      list.flatMap((s) =>
        [...s.paragraphs, ...s.items].map((t) => `${s.title}：${t}`),
      );
  const nowLines = lines(current),
    oldLines = lines(old),
    added = nowLines.filter((t) => !oldLines.includes(t)),
    removed = oldLines.filter((t) => !nowLines.includes(t));
  return LifecycleDocumentSchema.parse({
    schemaVersion: 1,
    sections: current,
    changes: previous
      ? {
          added: added.slice(0, 30).map((t) => t.slice(0, 1000)),
          removed: removed.slice(0, 30).map((t) => t.slice(0, 1000)),
          reordered:
            !added.length &&
            !removed.length &&
            JSON.stringify(nowLines) !== JSON.stringify(oldLines),
        }
      : null,
  });
}
