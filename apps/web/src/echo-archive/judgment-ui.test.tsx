import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  JudgmentForm,
  JudgmentResult,
} from "./EchoArchivePage";

const noop = vi.fn();

describe("回声档案双身份判定", () => {
  it("回放完成且 A/B 都选择身份后允许提交双重判断", () => {
    const markup = renderToStaticMarkup(
      <JudgmentForm
        completed
        guessA="human"
        guessB="ai"
        confidenceA={68}
        confidenceB={76}
        busy={false}
        error={null}
        onGuessA={noop}
        onGuessB={noop}
        onConfidenceA={noop}
        onConfidenceB={noop}
        onSubmit={noop}
      />,
    );

    expect(markup).toContain("匿名玩家 A");
    expect(markup).toContain("匿名玩家 B");
    expect(markup).toContain("提交双重判断");
    expect(markup).not.toContain('type="submit" disabled=""');
  });

  it("缺少任一身份时保持提交按钮禁用", () => {
    const markup = renderToStaticMarkup(
      <JudgmentForm
        completed
        guessA="human"
        guessB={null}
        confidenceA={68}
        confidenceB={68}
        busy={false}
        error={null}
        onGuessA={noop}
        onGuessB={noop}
        onConfidenceA={noop}
        onConfidenceB={noop}
        onSubmit={noop}
      />,
    );

    expect(markup).toContain('type="submit" disabled=""');
  });
});

describe("回声鉴证结案页", () => {
  it("逐项展示玩家判断、真实身份、置信度和计分去向", () => {
    const markup = renderToStaticMarkup(
      <JudgmentResult
        result={{
          completed: true,
          identities: { A: "human", B: "ai" },
          correct: { A: true, B: false },
          correctCount: 1,
          bothCorrect: false,
          scoreDelta: 4,
          confidenceCalibration: 61,
          stats: {
            reviewsPlayed: 6,
            identitiesCorrect: 8,
            perfectJudgments: 2,
            score: 32,
          },
        }}
        guesses={{ A: "human", B: "human" }}
        confidences={{ A: 72, B: 64 }}
        onReview={noop}
        onNext={noop}
      />,
    );

    expect(markup).toContain("命中一半");
    expect(markup).toContain("你的判断");
    expect(markup).toContain("真实身份");
    expect(markup).toContain("72%");
    expect(markup).toContain("64%");
    expect(markup).toContain("本局 +4");
    expect(markup).toContain("双身份全对 +10");
    expect(markup).toContain("带着答案重看");
  });
});
