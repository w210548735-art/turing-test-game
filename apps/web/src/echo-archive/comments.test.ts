import { describe, expect, it } from "vitest";
import type { EchoComment } from "@turing-game/protocol";
import {
  applyLikeSnapshot,
  commentsForEvent,
  shouldLoadEchoComments,
  sortEchoComments,
} from "./comments";

const COMMENTS: EchoComment[] = [
  {
    id: "62d37e16-b8b4-4740-a813-e92e9c2710e5",
    eventSequence: 3,
    authorAlias: "鉴证官 7K2",
    content: "停顿很自然。",
    createdAt: "2026-07-25T01:00:00.000Z",
    likeCount: 2,
    likedByMe: false,
    mine: false,
  },
  {
    id: "768c46cf-2918-4aa6-ab39-5f968e42dadf",
    eventSequence: 5,
    authorAlias: "鉴证官 X4M",
    content: "这句话像在转移问题。",
    createdAt: "2026-07-25T02:00:00.000Z",
    likeCount: 1,
    likedByMe: true,
    mine: false,
  },
  {
    id: "2b85ac02-88a0-43d4-901f-a9d30b3e1294",
    eventSequence: 3,
    authorAlias: "鉴证官 5HP",
    content: "但措辞有点模板化。",
    createdAt: "2026-07-25T03:00:00.000Z",
    likeCount: 5,
    likedByMe: false,
    mine: true,
  },
];

describe("回声批注纯逻辑", () => {
  it("判定前与结算页都不允许触发评论读取", () => {
    expect(shouldLoadEchoComments("playback", false, false)).toBe(false);
    expect(shouldLoadEchoComments("result", false, false)).toBe(false);
    expect(shouldLoadEchoComments("review", false, false)).toBe(true);
    expect(shouldLoadEchoComments("review", true, false)).toBe(false);
    expect(shouldLoadEchoComments("review", false, true)).toBe(false);
  });

  it("只把批注挂到对应的公开回放序号", () => {
    expect(commentsForEvent(COMMENTS, 3).map((comment) => comment.id)).toEqual([
      COMMENTS[0]?.id,
      COMMENTS[2]?.id,
    ]);
  });

  it("支持最新与热门排序且不改写原数组", () => {
    expect(sortEchoComments(COMMENTS, "latest")[0]?.id).toBe(COMMENTS[2]?.id);
    expect(sortEchoComments(COMMENTS, "popular")[0]?.id).toBe(COMMENTS[2]?.id);
    expect(COMMENTS[0]?.id).toBe("62d37e16-b8b4-4740-a813-e92e9c2710e5");
  });

  it("服务端点赞快照覆盖乐观状态并防止负数", () => {
    const updated = applyLikeSnapshot(
      COMMENTS,
      COMMENTS[0]!.id,
      true,
      -1,
    );
    expect(updated[0]).toMatchObject({ likedByMe: true, likeCount: 0 });
    expect(updated[1]).toBe(COMMENTS[1]);

    const rolledBack = applyLikeSnapshot(
      updated,
      COMMENTS[0]!.id,
      COMMENTS[0]!.likedByMe,
      COMMENTS[0]!.likeCount,
    );
    expect(rolledBack[0]).toEqual(COMMENTS[0]);
  });
});
