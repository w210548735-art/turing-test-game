import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import {
  echoArchiveEvents,
  echoArchives,
} from "../db/schema.js";

export interface HumanEchoSample {
  archiveId: string;
  publicSeat: number;
  offsetMs: number;
  content: string;
}

export interface HumanConversationStyleProfile {
  source: "echo_human_human" | "default";
  sampleArchives: number;
  sampleMessages: number;
  medianMessageCharacters: number;
  shortMessageRate: number;
  questionRate: number;
  informalMarkerRate: number;
  medianReplyDelayMs: number;
}

export const DEFAULT_HUMAN_STYLE_PROFILE: HumanConversationStyleProfile = {
  source: "default",
  sampleArchives: 0,
  sampleMessages: 0,
  medianMessageCharacters: 22,
  shortMessageRate: 0.7,
  questionRate: 0.3,
  informalMarkerRate: 0.25,
  medianReplyDelayMs: 2_600,
};

const MIN_PROFILE_MESSAGES = 6;
const DEFAULT_SAMPLE_LIMIT = 2_000;
const MAX_REPLY_DELAY_SAMPLE_MS = 60_000;
const SHORT_MESSAGE_CHARACTERS = 24;
const INFORMAL_MARKER_PATTERN =
  /(哈{1,}|嗯{1,}|呃{1,}|诶{1,}|欸{1,}|吧|嘛|啦|呀|啊|唉|em+|hh+|233|笑死|有点|感觉)/iu;

function clampRate(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function upperMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * 仅产出不可逆的聚合特征。返回对象不会保留任何原始消息或档案标识。
 */
export function analyzeHumanEchoSamples(
  samples: ReadonlyArray<HumanEchoSample>,
): HumanConversationStyleProfile {
  const normalized = samples
    .map((sample) => ({
      ...sample,
      content: sample.content.trim(),
    }))
    .filter((sample) => sample.content.length > 0);
  if (normalized.length < MIN_PROFILE_MESSAGES) {
    return { ...DEFAULT_HUMAN_STYLE_PROFILE };
  }

  const archives = new Map<string, typeof normalized>();
  for (const sample of normalized) {
    const archive = archives.get(sample.archiveId) ?? [];
    archive.push(sample);
    archives.set(sample.archiveId, archive);
  }

  const replyDelays: number[] = [];
  for (const archive of archives.values()) {
    const ordered = [...archive].sort(
      (left, right) => left.offsetMs - right.offsetMs,
    );
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (!previous || !current || previous.publicSeat === current.publicSeat) {
        continue;
      }
      const delay = current.offsetMs - previous.offsetMs;
      if (delay > 0 && delay <= MAX_REPLY_DELAY_SAMPLE_MS) {
        replyDelays.push(delay);
      }
    }
  }

  const lengths = normalized.map((sample) => [...sample.content].length);
  const shortMessages = lengths.filter(
    (length) => length <= SHORT_MESSAGE_CHARACTERS,
  ).length;
  const questions = normalized.filter((sample) =>
    /[?？]/u.test(sample.content),
  ).length;
  const informalMessages = normalized.filter((sample) =>
    INFORMAL_MARKER_PATTERN.test(sample.content),
  ).length;

  return {
    source: "echo_human_human",
    sampleArchives: archives.size,
    sampleMessages: normalized.length,
    medianMessageCharacters: Math.max(1, upperMedian(lengths)),
    shortMessageRate: clampRate(shortMessages / normalized.length),
    questionRate: clampRate(questions / normalized.length),
    informalMarkerRate: clampRate(informalMessages / normalized.length),
    medianReplyDelayMs:
      upperMedian(replyDelays) ||
      DEFAULT_HUMAN_STYLE_PROFILE.medianReplyDelayMs,
  };
}

/**
 * 只读取已公开、双方均为真人且未被安全处理标记的回声消息。
 * 原始行只存在于本函数局部作用域，调用方只能拿到聚合画像。
 */
export async function loadHumanEchoStyleProfile(
  database: AppDatabase,
  sampleLimit = DEFAULT_SAMPLE_LIMIT,
): Promise<HumanConversationStyleProfile> {
  const limit = Math.min(
    DEFAULT_SAMPLE_LIMIT,
    Math.max(MIN_PROFILE_MESSAGES, Math.floor(sampleLimit)),
  );
  const rows = await database
    .select({
      archiveId: echoArchiveEvents.archiveId,
      publicSeat: echoArchiveEvents.publicSeat,
      offsetMs: echoArchiveEvents.offsetMs,
      content: echoArchiveEvents.content,
    })
    .from(echoArchiveEvents)
    .innerJoin(
      echoArchives,
      eq(echoArchiveEvents.archiveId, echoArchives.id),
    )
    .where(
      and(
        eq(echoArchives.identityPattern, "human_human"),
        eq(echoArchives.status, "available"),
        eq(echoArchiveEvents.eventType, "message_visible"),
        eq(echoArchiveEvents.moderated, false),
        isNotNull(echoArchiveEvents.content),
      ),
    )
    .orderBy(
      desc(echoArchives.publishedAt),
      desc(echoArchiveEvents.eventSequence),
    )
    .limit(limit);

  return analyzeHumanEchoSamples(
    rows.flatMap((row) =>
      row.content
        ? [
            {
              archiveId: row.archiveId,
              publicSeat: row.publicSeat,
              offsetMs: row.offsetMs,
              content: row.content,
            },
          ]
        : [],
    ),
  );
}
