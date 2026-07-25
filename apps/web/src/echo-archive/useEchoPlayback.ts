import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  advanceClock,
  createPlaybackClock,
  nextMeaningfulOffset,
  pauseClock,
  playClock,
  reduceTimeline,
  seekClock,
  setClockSpeed,
  type EchoTimelineEvent,
  type PlaybackClock,
  type PlaybackSpeed,
} from "./playback";

export function useEchoPlayback(
  assignmentId: string,
  events: readonly EchoTimelineEvent[],
  durationMs: number,
) {
  const [clock, setClock] = useState<PlaybackClock>(createPlaybackClock);
  const [lastSkippedMs, setLastSkippedMs] = useState(0);
  const clockRef = useRef(clock);
  const animationFrameRef = useRef<number | null>(null);

  const commit = useCallback((next: PlaybackClock) => {
    clockRef.current = next;
    setClock(next);
  }, []);

  useEffect(() => {
    const reset = createPlaybackClock();
    clockRef.current = reset;
    setClock(reset);
    setLastSkippedMs(0);
  }, [assignmentId]);

  useEffect(() => {
    if (!clock.playing) return;
    const tick = (realNow: number) => {
      const next = advanceClock(clockRef.current, realNow, durationMs);
      clockRef.current = next;
      setClock(next);
      if (next.playing) {
        animationFrameRef.current = window.requestAnimationFrame(tick);
      } else {
        animationFrameRef.current = null;
      }
    };
    animationFrameRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [clock.playing, durationMs]);

  const play = useCallback(() => {
    setLastSkippedMs(0);
    commit(playClock(clockRef.current, performance.now(), durationMs));
  }, [commit, durationMs]);

  const pause = useCallback(() => {
    commit(pauseClock(clockRef.current, performance.now(), durationMs));
  }, [commit, durationMs]);

  const toggle = useCallback(() => {
    if (clockRef.current.playing) pause();
    else play();
  }, [pause, play]);

  const setSpeed = useCallback(
    (speed: PlaybackSpeed) => {
      commit(
        setClockSpeed(
          clockRef.current,
          speed,
          performance.now(),
          durationMs,
        ),
      );
    },
    [commit, durationMs],
  );

  const seek = useCallback(
    (positionMs: number) => {
      setLastSkippedMs(0);
      commit(
        seekClock(
          clockRef.current,
          positionMs,
          performance.now(),
          durationMs,
        ),
      );
    },
    [commit, durationMs],
  );

  const skipToNext = useCallback(() => {
    const from = clockRef.current.positionMs;
    const target = nextMeaningfulOffset(events, from, durationMs);
    setLastSkippedMs(Math.max(0, target - from));
    commit(
      seekClock(
        clockRef.current,
        target,
        performance.now(),
        durationMs,
      ),
    );
  }, [commit, durationMs, events]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden && clockRef.current.playing) pause();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, [pause]);

  const frame = useMemo(
    () => reduceTimeline(events, clock.positionMs),
    [clock.positionMs, events],
  );

  return {
    clock,
    frame,
    lastSkippedMs,
    completed: durationMs === 0 || clock.positionMs >= durationMs,
    play,
    pause,
    toggle,
    setSpeed,
    seek,
    skipToNext,
  };
}
