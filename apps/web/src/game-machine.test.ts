import { describe, expect, it } from "vitest";
import {
  canSubmitGuess,
  gameReducer,
  initialState,
  type GameState,
} from "./game-machine";

describe("gameReducer", () => {
  it("固定经过容量排队、匹配和五秒入场后才进入聊天", () => {
    const profiled = gameReducer(initialState, {
      type: "PROFILE_SAVED",
      nickname: "观察者",
      thinkingStatus: "正在验证假设…",
      demoMode: false,
    });
    const queued = gameReducer(profiled, {
      type: "MATCH_QUEUED",
      position: 3,
      queuedAt: 1_000,
    });
    expect(queued.screen).toBe("queue");
    expect(queued.queuePosition).toBe(3);

    const searching = gameReducer(queued, {
      type: "MATCH_SEARCHING",
      searchStartedAt: 2_000,
    });
    expect(searching.screen).toBe("matching");

    const admission = gameReducer(searching, {
      type: "MATCH_ADMISSION",
      gateEndsAt: 7_000,
    });
    expect(admission.screen).toBe("admission");

    const matched = gameReducer(admission, {
      type: "MATCH_FOUND",
      gameId: "g-1",
      startedAt: 7_000,
      endsAt: 307_000,
      minGuessAt: 27_000,
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
