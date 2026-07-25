export const TYPING_HEARTBEAT_INTERVAL_MS = 1_000;
export const TYPING_IDLE_TIMEOUT_MS = 900;

export function shouldStartTypingHeartbeat(
  draft: string,
  heartbeatActive: boolean,
): boolean {
  return draft.trim().length > 0 && !heartbeatActive;
}

export function shouldStopTyping(draft: string): boolean {
  return draft.trim().length === 0;
}
