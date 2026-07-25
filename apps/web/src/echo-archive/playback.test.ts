import { describe, expect, it } from "vitest";
import {
  advanceClock,
  createPlaybackClock,
  nextMeaningfulOffset,
  pauseClock,
  playClock,
  reduceTimeline,
  seekClock,
  setClockSpeed,
  sortTimeline,
  type EchoTimelineEvent,
} from "./playback";

const EVENTS: EchoTimelineEvent[] = [
  { sequence: 2, offsetMs: 3_000, type: "typing.stop", actor: "A" },
  { sequence: 1, offsetMs: 1_000, type: "typing.start", actor: "A" },
  {
    sequence: 3,
    offsetMs: 3_000,
    type: "message.visible",
    actor: "A",
    content: "你相信直觉吗？",
  },
  { sequence: 4, offsetMs: 8_000, type: "typing.start", actor: "B" },
  {
    sequence: 5,
    offsetMs: 11_000,
    type: "message.visible",
    actor: "B",
    content: "只信一半。",
  },
];

describe("回声档案时间轴", () => {
  it("按服务端相对时间和序号稳定排序", () => {
    expect(sortTimeline(EVENTS).map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("只在消息展示时刻将内容放入画面", () => {
    const before = reduceTimeline(EVENTS, 2_999);
    expect(before.messages).toHaveLength(0);
    expect(before.typing.A).toBe(true);
    expect(before.typingStartedAtMs.A).toBe(1_000);

    const visible = reduceTimeline(EVENTS, 3_000);
    expect(visible.messages.map((message) => message.id)).toEqual([
      "message-3",
    ]);
    expect(visible.messages[0]?.eventSequence).toBe(3);
    expect(visible.messages[0]?.typingDurationMs).toBe(2_000);
    expect(visible.typing.A).toBe(false);
  });

  it("快进跳到下一条可见内容并在末尾收束", () => {
    expect(nextMeaningfulOffset(EVENTS, 3_000, 15_000)).toBe(11_000);
    expect(nextMeaningfulOffset(EVENTS, 11_000, 15_000)).toBe(15_000);
  });
});

describe("回声档案播放时钟", () => {
  it("按倍速推进并在时长末尾自动暂停", () => {
    const playing = playClock(createPlaybackClock(2), 100, 10_000);
    expect(advanceClock(playing, 2_100, 10_000).positionMs).toBe(4_000);
    const ended = advanceClock(playing, 6_000, 10_000);
    expect(ended.positionMs).toBe(10_000);
    expect(ended.playing).toBe(false);
  });

  it("切换倍速时先按旧速度结算再重设基准", () => {
    const playing = playClock(createPlaybackClock(1), 1_000, 20_000);
    const faster = setClockSpeed(playing, 4, 3_000, 20_000);
    expect(faster.positionMs).toBe(2_000);
    expect(advanceClock(faster, 4_000, 20_000).positionMs).toBe(6_000);
  });

  it("暂停、拖动与重新播放不会累积暂停时间", () => {
    const playing = playClock(createPlaybackClock(), 0, 20_000);
    const paused = pauseClock(playing, 3_000, 20_000);
    expect(advanceClock(paused, 9_000, 20_000).positionMs).toBe(3_000);

    const sought = seekClock(paused, 12_000, 9_000, 20_000);
    const resumed = playClock(sought, 10_000, 20_000);
    expect(advanceClock(resumed, 11_000, 20_000).positionMs).toBe(
      13_000,
    );
  });
});
