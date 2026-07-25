import type { EchoRecordsResponse } from "@turing-game/protocol";

export interface EchoRecordOutcome {
  label: string;
  marker: string;
  tone: "perfect" | "partial" | "wrong";
}

export function echoIdentityHitRate(
  stats: EchoRecordsResponse["stats"],
): number {
  if (stats.reviewsPlayed === 0) return 0;
  return Math.round(
    (stats.identitiesCorrect / (stats.reviewsPlayed * 2)) * 100,
  );
}

export function echoRecordOutcome(
  correctCount: number,
): EchoRecordOutcome {
  if (correctCount >= 2) {
    return { label: "双重命中", marker: "2/2", tone: "perfect" };
  }
  if (correctCount === 1) {
    return { label: "命中一半", marker: "1/2", tone: "partial" };
  }
  return { label: "判断偏差", marker: "0/2", tone: "wrong" };
}
