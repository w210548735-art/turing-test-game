import { describe, expect, it } from "vitest";
import {
  canSubmitGuess,
  gameReducer,
  initialState,
  type GameState,
} from "./game-machine";

describe("gameReducer", () => {
  it("固定经过匹配屏后才进入聊天", () => {
    const profiled = gameReducer(initialState, {
      type: "PROFILE_SAVED",
      nickname: "观察者",
      thinkingStatus: "正在验证假设…",
      demoMode: false,
    });
    const queued = gameReducer(profiled, {
      type: "MATCH_QUEUED",
      gateEndsAt: 5_000,
    });
    expect(queued.screen).toBe("matching");

    const matched = gameReducer(queued, {
      type: "MATCH_FOUND",
      gameId: "g-1",
      startedAt: 5_000,
      endsAt: 305_000,
      minGuessAt: 25_000,
      opponentLabel: "匿名玩家",
    });
    expect(matched.screen).toBe("chat");
    expect(matched.minGuessAt! - matched.startedAt!).toBe(20_000);
  });

  it("拒绝重复消息并按服务端序号排序", () => {
    const first = gameReducer(initialState, {
      type: "MESSAGE_RECEIVED",
      message: {
        id: "m-2",
        sender: "opponent",
        content: "第二条",
        sequence: 2,
        createdAt: 2,
      },
    });
    const second = gameReducer(first, {
      type: "MESSAGE_RECEIVED",
      message: {
        id: "m-1",
        sender: "self",
        content: "第一条",
        sequence: 1,
        createdAt: 1,
      },
    });
    const duplicate = gameReducer(second, {
      type: "MESSAGE_RECEIVED",
      message: {
        id: "m-1",
        sender: "self",
        content: "重复",
        sequence: 3,
        createdAt: 3,
      },
    });
    expect(duplicate.messages.map((message) => message.id)).toEqual([
      "m-1",
      "m-2",
    ]);
  });
});

describe("canSubmitGuess", () => {
  const state = {
    ...initialState,
    screen: "chat",
    minGuessAt: 20_000,
  } satisfies GameState;

  it("满 20 秒才允许提交一次判断", () => {
    expect(canSubmitGuess(state, 19_999)).toBe(false);
    expect(canSubmitGuess(state, 20_000)).toBe(true);
    expect(
      canSubmitGuess({ ...state, guessSubmitted: "human" }, 20_000),
    ).toBe(false);
  });
});
