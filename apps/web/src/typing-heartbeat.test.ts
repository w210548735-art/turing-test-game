import { describe, expect, it } from "vitest";
import {
  shouldStartTypingHeartbeat,
  shouldStopTyping,
} from "./typing-heartbeat";

describe("输入状态心跳", () => {
  it("非空草稿只在尚无心跳时启动一次", () => {
    expect(shouldStartTypingHeartbeat("正在输入", false)).toBe(true);
    expect(shouldStartTypingHeartbeat("正在输入", true)).toBe(false);
  });

  it("清空草稿时停止输入状态", () => {
    expect(shouldStopTyping("   ")).toBe(true);
    expect(shouldStopTyping("还在输入")).toBe(false);
  });
});
