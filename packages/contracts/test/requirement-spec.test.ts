import { describe, expect, it } from "vitest";

import { RequirementSpecSchema } from "../src/index.js";

describe("RequirementSpec", () => {
  it("接受面向业务人员的需求说明", () => {
    const result = RequirementSpecSchema.safeParse({
      schemaVersion: 1,
      title: "访客预约",
      goal: "让访客到访过程更顺畅",
      userStories: [
        {
          role: "物业前台",
          need: "查看今天即将到访的访客",
          value: "提前做好接待准备",
        },
      ],
      acceptanceCriteria: [
        {
          title: "访客可以提交预约",
          description: "填写姓名、手机号和到访时间后能够提交",
          priority: "must",
        },
      ],
      openQuestions: [],
    });

    expect(result.success).toBe(true);
  });

  it("拒绝只有内部编码、没有可读标题的需求", () => {
    const result = RequirementSpecSchema.safeParse({
      schemaVersion: 1,
      title: "REQ-102",
      goal: "让访客到访过程更顺畅",
      userStories: [],
      acceptanceCriteria: [
        {
          title: "访客可以提交预约",
          description: "填写必要信息后能够提交预约",
          priority: "must",
        },
      ],
      openQuestions: [],
    });

    expect(result.success).toBe(false);
  });

  it("要求至少一个可验证的验收条件", () => {
    const result = RequirementSpecSchema.safeParse({
      schemaVersion: 1,
      title: "访客预约",
      goal: "让访客到访过程更顺畅",
      userStories: [],
      acceptanceCriteria: [],
      openQuestions: [],
    });

    expect(result.success).toBe(false);
  });
});
