import type { EchoReplayEvent } from "@turing-game/protocol";

export type EchoActor = "A" | "B";
export type PlaybackSpeed = 0.5 | 1 | 2 | 4;

export type EchoTimelineEvent = EchoReplayEvent;

export interface EchoReplayMessage {
  id: string;
  eventSequence: number;
  actor: EchoActor | "system";
  content: string;
  atMs: number;
  moderated: boolean;
  typingDurationMs: number | null;
}

export interface EchoReplayFrame {
  messages: EchoReplayMessage[];
  typing: Record<EchoActor, boolean>;
  typingStartedAtMs: Record<EchoActor, number | null>;
}

export interface PlaybackClock {
  positionMs: number;
  baseReplayMs: number;
  baseRealMs: number;
  speed: PlaybackSpeed;
  playing: boolean;
}

const EMPTY_TYPING: Record<EchoActor, boolean> = { A: false, B: false };
const EMPTY_TYPING_STARTED: Record<EchoActor, number | null> = {
  A: null,
  B: null,
};

export function sortTimeline(
  events: readonly EchoTimelineEvent[],
): EchoTimelineEvent[] {
  return [...events].sort(
    (left, right) =>
      left.offsetMs - right.offsetMs || left.sequence - right.sequence,
  );
}

export function reduceTimeline(
  events: readonly EchoTimelineEvent[],
  positionMs: number,
): EchoReplayFrame {
  const frame: EchoReplayFrame = {
    messages: [],
    typing: { ...EMPTY_TYPING },
    typingStartedAtMs: { ...EMPTY_TYPING_STARTED },
  };
  const completedTypingDurationMs: Record<EchoActor, number | null> = {
    A: null,
    B: null,
  };

  for (const event of sortTimeline(events)) {
    if (event.offsetMs > positionMs) break;
    if (event.type === "typing.start") {
      frame.typing[event.actor] = true;
      frame.typingStartedAtMs[event.actor] = event.offsetMs;
      completedTypingDurationMs[event.actor] = null;
      continue;
    }
    if (event.type === "typing.stop") {
      const typingStartedAt = frame.typingStartedAtMs[event.actor];
      completedTypingDurationMs[event.actor] =
        typingStartedAt === null
          ? null
          : Math.max(0, event.offsetMs - typingStartedAt);
      frame.typing[event.actor] = false;
      frame.typingStartedAtMs[event.actor] = null;
      continue;
    }
    if (event.type === "message.visible") {
      const typingStartedAt = frame.typingStartedAtMs[event.actor];
      frame.typing[event.actor] = false;
      frame.typingStartedAtMs[event.actor] = null;
      frame.messages.push({
        id: `message-${event.sequence}`,
        eventSequence: event.sequence,
        actor: event.actor,
        content: event.content ?? "[该条内容不可用]",
        atMs: event.offsetMs,
        moderated: event.moderated ?? false,
        typingDurationMs:
          typingStartedAt === null
            ? completedTypingDurationMs[event.actor]
            : Math.max(0, event.offsetMs - typingStartedAt),
      });
      completedTypingDurationMs[event.actor] = null;
    }
  }

  return frame;
}

export function createPlaybackClock(
  speed: PlaybackSpeed = 1,
): PlaybackClock {
  return {
    positionMs: 0,
    baseReplayMs: 0,
    baseRealMs: 0,
    speed,
    playing: false,
  };
}

export function advanceClock(
  clock: PlaybackClock,
  realNow: number,
  durationMs: number,
): PlaybackClock {
  if (!clock.playing) return clock;
  const positionMs = Math.min(
    durationMs,
    Math.max(
      0,
      clock.baseReplayMs +
        (realNow - clock.baseRealMs) * clock.speed,
    ),
  );
  return {
    ...clock,
    positionMs,
    playing: positionMs < durationMs,
  };
}

export function playClock(
  clock: PlaybackClock,
  realNow: number,
  durationMs: number,
): PlaybackClock {
  const positionMs =
    clock.positionMs >= durationMs ? 0 : clock.positionMs;
  return {
    ...clock,
    positionMs,
    baseReplayMs: positionMs,
    baseRealMs: realNow,
    playing: durationMs > 0,
  };
}

export function pauseClock(
  clock: PlaybackClock,
  realNow: number,
  durationMs: number,
): PlaybackClock {
  return {
    ...advanceClock(clock, realNow, durationMs),
    playing: false,
  };
}

export function setClockSpeed(
  clock: PlaybackClock,
  speed: PlaybackSpeed,
  realNow: number,
  durationMs: number,
): PlaybackClock {
  const rebased = advanceClock(clock, realNow, durationMs);
  return {
    ...rebased,
    speed,
    baseReplayMs: rebased.positionMs,
    baseRealMs: realNow,
  };
}

export function seekClock(
  clock: PlaybackClock,
  positionMs: number,
  realNow: number,
  durationMs: number,
): PlaybackClock {
  const clamped = Math.min(durationMs, Math.max(0, positionMs));
  return {
    ...clock,
    positionMs: clamped,
    baseReplayMs: clamped,
    baseRealMs: realNow,
    playing: clock.playing && clamped < durationMs,
  };
}

export function nextMeaningfulOffset(
  events: readonly EchoTimelineEvent[],
  positionMs: number,
  durationMs: number,
): number {
  const next = sortTimeline(events).find(
    (event) =>
      event.offsetMs > positionMs && event.type === "message.visible",
  );
  return Math.min(durationMs, next?.offsetMs ?? durationMs);
}

export function formatReplayTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(
    totalSeconds % 60,
  ).padStart(2, "0")}`;
}
