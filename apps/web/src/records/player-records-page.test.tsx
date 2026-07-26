import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EchoRecordsResponse } from "@turing-game/protocol";
import { EMPTY_LOCAL_RECORD } from "../local-record";
import {
  PlayerRecordsPage,
  RecordPageTemplate,
  buildEchoRecordModel,
} from "./PlayerRecordsPage";

const noop = vi.fn();

const echoRecords: EchoRecordsResponse = {
  stats: {
    reviewsPlayed: 2,
    identitiesCorrect: 3,
    perfectJudgments: 1,
    score: 14,
  },
  records: [
    {
      id: "177e9b97-f8a9-42ea-9560-518f1f39ffcf",
      submittedAt: "2026-07-25T02:00:00.000Z",
      identities: { A: "human", B: "ai" },
      guesses: { A: "human", B: "human" },
      confidence: { A: 82, B: 61 },
      correct: { A: true, B: false },
      correctCount: 1,
      bothCorrect: false,
      scoreDelta: 4,
      confidenceCalibration: 61,
      durationMs: 42_000,
      messageCount: 8,
    },
  ],
};

describe("统一玩家战绩页面", () => {
  it("1v1 战绩只展示统计和历史，并提供独立设置入口", () => {
    const markup = renderToStaticMarkup(
      <PlayerRecordsPage
        record={EMPTY_LOCAL_RECORD}
        accountUser={{
          id: "7febf16e-48ef-4ef4-8422-edb227b6b7fe",
          email: "player@example.com",
          playerNumber: 100001,
          displayName: "夜航观察员",
          status: "ACTIVE",
          role: "PLAYER",
        }}
        mode="duel"
        onModeChange={noop}
        onBack={noop}
        onSettings={noop}
      />,
    );

    expect(markup).toContain("玩家档案");
    expect(markup).toContain("全局玩家名称");
    expect(markup).toContain("夜航观察员");
    expect(markup).toContain("账户设置");
    expect(markup).toContain("1v1 战绩");
    expect(markup).toContain("累计消息");
    expect(markup).not.toContain("修改账号密码");
    expect(markup).not.toContain("全局账户名称");
    expect(markup).not.toContain("在这里切换查看");
  });

  it("回声鉴证使用同一模板，只替换统计与记录数据", () => {
    const markup = renderToStaticMarkup(
      <RecordPageTemplate
        model={buildEchoRecordModel(echoRecords)}
        identityLabel="夜航观察员 · NO. 100001"
        mode="echo"
        echoEnabled
        onModeChange={noop}
        onBack={noop}
        onSettings={noop}
      />,
    );

    expect(markup).toContain("player-records-shell");
    expect(markup).toContain("回声鉴证");
    expect(markup).toContain("身份命中率");
    expect(markup).toContain("1/2");
    expect(markup).toContain(
      "匿名档案 · 仅展示判断结果，不展示原玩家或聊天正文",
    );
    expect(markup).not.toContain("继续鉴证新的回声");
    expect(markup).not.toContain("每次双身份判断都会留下鉴证切片");
  });
});
