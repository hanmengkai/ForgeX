import { z } from "zod";

const internalCodePattern = /^(?:REQ|BUG|TASK|FEAT|STORY)[-_]?\d+$/i;

const readableText = (fieldName: string, minimumLength = 2) =>
  z
    .string()
    .trim()
    .min(minimumLength, `${fieldName}需要使用可理解的业务语言`);

export const UserStorySchema = z.object({
  role: readableText("使用角色"),
  need: readableText("用户需要"),
  value: readableText("业务价值")
});

export const AcceptanceCriterionSchema = z.object({
  title: readableText("验收条件标题"),
  description: readableText("验收条件说明", 4),
  priority: z.enum(["must", "should", "could"])
});

export const RequirementSpecSchema = z.object({
  schemaVersion: z.literal(1),
  title: readableText("需求标题").refine(
    (title) => !internalCodePattern.test(title),
    "需求标题不能只有内部编码"
  ),
  goal: readableText("需求目标", 4),
  userStories: z.array(UserStorySchema),
  acceptanceCriteria: z
    .array(AcceptanceCriterionSchema)
    .min(1, "至少需要一个可验证的验收条件"),
  openQuestions: z.array(readableText("待澄清问题"))
});

export type RequirementSpec = z.infer<typeof RequirementSpecSchema>;
export type UserStory = z.infer<typeof UserStorySchema>;
export type AcceptanceCriterion = z.infer<
  typeof AcceptanceCriterionSchema
>;

