import { describe, expect, it } from "vitest";
import {
  echoIdentityHitRate,
  echoRecordOutcome,
} from "./records";

describe("回声鉴证战绩展示规则", () => {
  it("按判读的两个身份计算总体命中率", () => {
    expect(
      echoIdentityHitRate({
        reviewsPlayed: 3,
        identitiesCorrect: 4,
        perfectJudgments: 1,
        score: 18,
      }),
    ).toBe(67);
    expect(
      echoIdentityHitRate({
        reviewsPlayed: 0,
        identitiesCorrect: 0,
        perfectJudgments: 0,
        score: 0,
      }),
    ).toBe(0);
  });

  it("区分双重命中、命中一半和判断偏差", () => {
    expect(echoRecordOutcome(2)).toEqual({
      label: "双重命中",
      marker: "2/2",
      tone: "perfect",
    });
    expect(echoRecordOutcome(1).label).toBe("命中一半");
    expect(echoRecordOutcome(0).tone).toBe("wrong");
  });
});
