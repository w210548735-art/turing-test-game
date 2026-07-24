import type { GameResult } from "./game-machine";

export interface LocalPlayerRecord {
  rounds: number;
  correctGuesses: number;
  totalScore: number;
  games: LocalGameRecord[];
  lastRecordedGameId: string | null;
}

export interface LocalGameRecord {
  id: string;
  finishedAt: number;
  opponentType: GameResult["opponentType"];
  guess: GameResult["guess"];
  isCorrect: boolean;
  durationSeconds: number;
  messageCount: number;
  scoreDelta: number;
}

export const EMPTY_LOCAL_RECORD: LocalPlayerRecord = {
  rounds: 0,
  correctGuesses: 0,
  totalScore: 0,
  games: [],
  lastRecordedGameId: null,
};

export function localRecordKey(accountId?: string): string {
  return `turing.local-record.v1:${accountId || "local-demo"}`;
}

export function parseLocalRecord(value: string | null): LocalPlayerRecord {
  if (!value) return { ...EMPTY_LOCAL_RECORD };
  try {
    const candidate = JSON.parse(value) as Partial<LocalPlayerRecord>;
    return {
      rounds: safeCount(candidate.rounds),
      correctGuesses: safeCount(candidate.correctGuesses),
      totalScore: safeCount(candidate.totalScore),
      games: Array.isArray(candidate.games)
        ? candidate.games
            .filter(isLocalGameRecord)
            .slice(0, 50)
        : [],
      lastRecordedGameId:
        typeof candidate.lastRecordedGameId === "string"
          ? candidate.lastRecordedGameId
          : null,
    };
  } catch {
    return { ...EMPTY_LOCAL_RECORD };
  }
}

export function readLocalRecord(key: string): LocalPlayerRecord {
  try {
    return parseLocalRecord(window.localStorage.getItem(key));
  } catch {
    return { ...EMPTY_LOCAL_RECORD };
  }
}

export function writeLocalRecord(
  key: string,
  record: LocalPlayerRecord,
): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // 隐私模式或存储配额异常时，当前会话内仍可继续展示记录。
  }
}

export function recordFinishedGame(
  record: LocalPlayerRecord,
  gameId: string,
  result: GameResult,
): LocalPlayerRecord {
  if (record.lastRecordedGameId === gameId) return record;
  const scoreDelta = Math.max(
    0,
    Math.floor(result.stats?.scoreDelta ?? (result.isCorrect ? 12 : 0)),
  );
  return {
    rounds: record.rounds + 1,
    correctGuesses: record.correctGuesses + (result.isCorrect ? 1 : 0),
    totalScore: record.totalScore + scoreDelta,
    games: [
      {
        id: gameId,
        finishedAt: Date.now(),
        opponentType: result.opponentType,
        guess: result.guess,
        isCorrect: result.isCorrect,
        durationSeconds: safeCount(result.stats?.durationSeconds),
        messageCount: safeCount(result.stats?.messageCount),
        scoreDelta,
      },
      ...record.games.filter((game) => game.id !== gameId),
    ].slice(0, 50),
    lastRecordedGameId: gameId,
  };
}

export function hitRate(record: LocalPlayerRecord): number {
  if (record.rounds === 0) return 0;
  return Math.round((record.correctGuesses / record.rounds) * 100);
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function isLocalGameRecord(value: unknown): value is LocalGameRecord {
  if (!value || typeof value !== "object") return false;
  const game = value as Partial<LocalGameRecord>;
  return (
    typeof game.id === "string" &&
    typeof game.finishedAt === "number" &&
    (game.opponentType === "human" || game.opponentType === "ai") &&
    (game.guess === null || game.guess === "human" || game.guess === "ai") &&
    typeof game.isCorrect === "boolean" &&
    typeof game.durationSeconds === "number" &&
    typeof game.messageCount === "number" &&
    typeof game.scoreDelta === "number"
  );
}
