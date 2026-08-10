import { describe, expect, it } from "vitest";

import {
  KnowledgeBase,
  KnowledgeBaseSnapshotSchema,
  type KnowledgeSourceRevision,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const knowledgeKey = "33333333-3333-4333-8333-333333333333";
const sourceKey = "44444444-4444-4444-8444-444444444444";
const creationKey = "77777777-7777-4777-8777-777777777777";
const publicationKey = "88888888-8888-4888-8888-888888888888";
const actor = {
  actorKey: "55555555-5555-4555-8555-555555555555",
  actorName: "需求分析师",
};

const sourceRevision = (
  overrides: Partial<KnowledgeSourceRevision> = {},
): KnowledgeSourceRevision => ({
  schemaVersion: 1,
  tenantKey,
  projectKey,
  knowledgeKey,
  publicationKey,
  sourceKey,
  revision: 1,
  title: "访客预约规则",
  mediaType: "text/markdown",
  contentHashAlgorithm: "sha256",
  contentHash: "a".repeat(64),
  byteLength: 1_024,
  status: "active",
  contentTrust: "reference_only",
  publishedBy: actor,
  publishedAt: "2026-08-10T10:00:00.000Z",
  ...overrides,
});

const createBase = () =>
  new KnowledgeBase({
    tenantKey,
    projectKey,
    knowledgeKey,
    creationKey,
    name: "访客业务资料",
    summary: "集中管理访客预约、到访和接待规则",
    classification: "team",
    createdBy: actor,
    createdAt: "2026-08-10T09:00:00.000Z",
  });

describe("KnowledgeBase", () => {
  it("按连续版本发布内容寻址资料，并生成不暴露内部标识的人性化视图", () => {
    const knowledge = createBase();
    knowledge.publishSource(sourceRevision());
    knowledge.publishSource(
      sourceRevision({
        revision: 2,
        publicationKey: "99999999-9999-4999-8999-999999999999",
        contentHash: "b".repeat(64),
        byteLength: 1_280,
        publishedAt: "2026-08-10T11:00:00.000Z",
      }),
    );

    expect(knowledge.listActiveSources()).toEqual([
      expect.objectContaining({
        title: "访客预约规则",
        revision: 2,
        contentHash: "b".repeat(64),
        contentTrust: "reference_only",
      }),
    ]);
    expect(knowledge.itemForPeople()).toEqual({
      knowledgeKey,
      view: {
        name: "访客业务资料",
        summary: "集中管理访客预约、到访和接待规则",
        classification: "项目成员可使用",
        status: "可使用",
        detail: "已整理 1 份资料",
        lastUpdatedAt: "2026-08-10T11:00:00.000Z",
      },
    });
    expect(JSON.stringify(knowledge.itemForPeople().view)).not.toMatch(
      /33333333|44444444|sha256|reference_only/,
    );
  });

  it("同一版本只能幂等重放，拒绝覆盖、跳号和跨范围资料", () => {
    const knowledge = createBase();
    const first = sourceRevision();
    knowledge.publishSource(first);
    expect(() => knowledge.publishSource(first)).not.toThrow();
    expect(() =>
      knowledge.publishSource({ ...first, title: "被偷偷替换" }),
    ).toThrow("同一版本的业务资料不能被覆盖");
    expect(() =>
      knowledge.publishSource(
        sourceRevision({
          revision: 3,
          publicationKey: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        }),
      ),
    ).toThrow("业务资料版本必须连续发布");
    expect(() =>
      knowledge.publishSource(
        sourceRevision({
          tenantKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
      ),
    ).toThrow("业务资料不属于当前知识库");
  });

  it("归档后不再参与检索，恢复快照仍保留完整版本与发布人证据", () => {
    const knowledge = createBase();
    knowledge.publishSource(sourceRevision());
    knowledge.archiveSource(
      sourceKey,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      actor,
      "2026-08-10T12:00:00.000Z",
    );

    expect(knowledge.listActiveSources()).toEqual([]);
    expect(knowledge.itemForPeople().view).toMatchObject({
      status: "需要补充资料",
      detail: "尚未加入可用资料",
    });
    const snapshot = knowledge.snapshot();
    expect(snapshot.revision).toBe(3);
    expect(snapshot.sourceHistory).toHaveLength(2);
    expect(snapshot.sourceHistory[1]).toMatchObject({
      sourceKey,
      revision: 2,
      status: "archived",
      publishedBy: actor,
    });
    expect(KnowledgeBase.fromSnapshot(snapshot).snapshot()).toEqual(snapshot);
  });

  it("恢复时拒绝被删改的历史顺序、知识库版本和重复可见名称", () => {
    const knowledge = createBase();
    knowledge.publishSource(sourceRevision());
    const snapshot = knowledge.snapshot();

    expect(() =>
      KnowledgeBase.fromSnapshot({ ...snapshot, revision: 99 }),
    ).toThrow("知识库版本与资料历史不一致");
    expect(() =>
      KnowledgeBase.fromSnapshot({
        ...snapshot,
        sourceHistory: [
          ...snapshot.sourceHistory,
          sourceRevision({
            sourceKey: "66666666-6666-4666-8666-666666666666",
            publicationKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            title: "访客预约规则",
            contentHash: "c".repeat(64),
          }),
        ],
        revision: 3,
      }),
    ).toThrow("可用业务资料名称不能重复");
    expect(
      KnowledgeBaseSnapshotSchema.safeParse({
        ...snapshot,
        sourceHistory: [
          { ...snapshot.sourceHistory[0]!, contentTrust: "instructions" },
        ],
      }).success,
    ).toBe(false);
  });
});
