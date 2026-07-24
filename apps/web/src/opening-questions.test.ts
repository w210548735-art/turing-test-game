import { describe, expect, it } from "vitest";
import {
  OPENING_QUESTION_POOL,
  pickOpeningQuestions,
} from "./opening-questions";

describe("开场问题题库", () => {
  it("维护十道互不重复的问题", () => {
    expect(OPENING_QUESTION_POOL).toHaveLength(10);
    expect(new Set(OPENING_QUESTION_POOL)).toHaveLength(10);
  });

  it("每次抽取三道且不重复", () => {
    const questions = pickOpeningQuestions(3, () => 0.42);
    const questionPool = new Set<string>(OPENING_QUESTION_POOL);

    expect(questions).toHaveLength(3);
    expect(new Set(questions)).toHaveLength(3);
    expect(questions.every((question) => questionPool.has(question))).toBe(
      true,
    );
  });

  it("拒绝越界数量和无效随机数", () => {
    expect(() => pickOpeningQuestions(11)).toThrow(RangeError);
    expect(() => pickOpeningQuestions(3, () => 1)).toThrow(RangeError);
  });
});
