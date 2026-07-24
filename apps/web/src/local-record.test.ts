import { describe, expect, it } from "vitest";
import {
  EMPTY_LOCAL_RECORD,
  hitRate,
  parseLocalRecord,
  recordFinishedGame,
} from "./local-record";

describe("本机玩家记录", () => {
  it("损坏或缺失的数据安全回退为空记录", () => {
    expect(parseLocalRecord(null)).toEqual(EMPTY_LOCAL_RECORD);
    expect(parseLocalRecord("{bad json")).toEqual(EMPTY_LOCAL_RECORD);
  });

  it("结算只记录一次并累计命中、得分和最佳连胜", () => {
    const first = recordFinishedGame(EMPTY_LOCAL_RECORD, "game-1", {
      opponentType: "ai",
      guess: "ai",
      isCorrect: true,
      outcome: "won",
      stats: { scoreDelta: 12, streak: 2 },
    });
    expect(first).toMatchObject({
      rounds: 1,
      correctGuesses: 1,
      totalScore: 12,
    });
    expect(first.games).toHaveLength(1);
    expect(first.games[0]).toMatchObject({
      id: "game-1",
      opponentType: "ai",
      guess: "ai",
      isCorrect: true,
      scoreDelta: 12,
    });
    expect(recordFinishedGame(first, "game-1", {
      opponentType: "ai",
      guess: "ai",
      isCorrect: true,
      outcome: "won",
    })).toBe(first);
  });

  it("命中率取整并正确处理零局", () => {
    expect(hitRate(EMPTY_LOCAL_RECORD)).toBe(0);
    expect(hitRate({
      ...EMPTY_LOCAL_RECORD,
      rounds: 3,
      correctGuesses: 2,
    })).toBe(67);
  });
});
