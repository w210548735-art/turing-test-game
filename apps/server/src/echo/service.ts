import { randomUUID } from "node:crypto";
import type {
  ArchiveConsentDecision,
  EchoAssignmentResponse,
  EchoComment,
  EchoCommentLikeResponse,
  EchoCommentsResponse,
  DeleteEchoCommentResponse,
  EchoRecordsResponse,
  SubmitEchoCommentRequest,
  SubmitEchoJudgmentRequest,
  SubmitEchoJudgmentResponse,
} from "@turing-game/protocol";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  notExists,
  sql,
} from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import {
  echoArchiveEvents,
  echoArchives,
  echoArchiveSources,
  echoAssignments,
  echoCommentAuthors,
  echoCommentLikes,
  echoComments,
  echoConsents,
  echoJudgments,
  echoReviewerStats,
  gameParticipants,
  games,
  gameTimelineEvents,
  messages,
  moderationEvents,
  reports,
  type EchoAssignmentRow,
} from "../db/schema.js";
import { AppError } from "../errors.js";
import { ModerationPipeline } from "../moderation/index.js";

const CONSENT_TTL_MS = 24 * 60 * 60_000;
const ASSIGNMENT_TTL_MS = 30 * 60_000;
const MAX_COMMENTS_PER_ARCHIVE = 500;
const MAX_COMMENTS_PER_REVIEWER_PER_ARCHIVE = 5;
const MAX_REVIEWER_RECORDS = 50;

export type TimelineEventType =
  | "room_started"
  | "typing_start"
  | "typing_stop"
  | "message_received"
  | "message_visible";

export interface AppendTimelineEventInput {
  gameId: string;
  sequence: number;
  eventType: TimelineEventType;
  actorParticipantId?: string;
  messageId?: string;
  occurredAt: number;
  moderated?: boolean;
}

export interface InitializeArchiveInput {
  gameId: string;
  durationMs: number;
  eligible: boolean;
  now?: number;
}

export interface SubmitConsentInput {
  gameId: string;
  userId: string;
  decision: ArchiveConsentDecision;
  clientRequestId: string;
  now?: number;
}

export interface EchoServiceOptions {
  now?: () => number;
  random?: () => number;
  moderation?: ModerationPipeline;
}

function publicActor(seat: number): "A" | "B" {
  return seat === 0 ? "A" : "B";
}

export class EchoArchiveService {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly moderation: ModerationPipeline;

  constructor(
    private readonly db: AppDatabase,
    options: EchoServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.moderation = options.moderation ?? new ModerationPipeline();
  }

  async appendTimelineEvent(input: AppendTimelineEventInput): Promise<void> {
    await this.db
      .insert(gameTimelineEvents)
      .values({
        id: randomUUID(),
        gameId: input.gameId,
        eventSequence: input.sequence,
        eventType: input.eventType,
        actorParticipantId: input.actorParticipantId,
        messageId: input.messageId,
        occurredAt: new Date(input.occurredAt),
        metadata: input.moderated
          ? { moderated: true }
          : {},
      })
      .onConflictDoNothing({
        target: [
          gameTimelineEvents.gameId,
          gameTimelineEvents.eventSequence,
        ],
      });
  }

  async initializeArchiveCandidate(
    input: InitializeArchiveInput,
  ): Promise<boolean> {
    if (!input.eligible) return false;
    const now = new Date(input.now ?? this.now());
    return this.db.transaction(async (transaction) => {
      const participants = await transaction
        .select()
        .from(gameParticipants)
        .where(eq(gameParticipants.gameId, input.gameId))
        .orderBy(asc(gameParticipants.seat));
      if (participants.length !== 2) return false;
      const aiCount = participants.filter(
        (participant) => participant.identityType === "ai",
      ).length;
      if (aiCount > 1) return false;

      const [existing] = await transaction
        .select()
        .from(echoArchives)
        .where(eq(echoArchives.sourceGameId, input.gameId))
        .limit(1);
      if (existing) {
        return existing.status === "pending" || existing.status === "available";
      }

      const [archive] = await transaction
        .insert(echoArchives)
        .values({
          id: randomUUID(),
          sourceGameId: input.gameId,
          status: "pending",
          identityPattern: aiCount === 0 ? "human_human" : "human_ai",
          durationMs: Math.max(0, Math.floor(input.durationMs)),
          consentExpiresAt: new Date(now.getTime() + CONSENT_TTL_MS),
          createdAt: now,
        })
        .returning();
      if (!archive) return false;

      const ai = participants.find(
        (participant) => participant.identityType === "ai",
      );
      if (ai) {
        await transaction.insert(echoConsents).values({
          id: randomUUID(),
          gameId: input.gameId,
          participantId: ai.id,
          decision: "approve",
          clientRequestId: randomUUID(),
          decidedAt: now,
        });
      }
      return true;
    });
  }

  async submitConsent(input: SubmitConsentInput): Promise<void> {
    const now = new Date(input.now ?? this.now());
    await this.db.transaction(async (transaction) => {
      const [participant] = await transaction
        .select()
        .from(gameParticipants)
        .where(
          and(
            eq(gameParticipants.gameId, input.gameId),
            eq(gameParticipants.userId, input.userId),
            eq(gameParticipants.identityType, "human"),
          ),
        )
        .limit(1);
      if (!participant) {
        throw new AppError(
          "ARCHIVE_CONSENT_UNAVAILABLE",
          "这局对话暂时无法保存，请继续体验其他对局。",
          409,
        );
      }

      const [requestReplay] = await transaction
        .select()
        .from(echoConsents)
        .where(eq(echoConsents.clientRequestId, input.clientRequestId))
        .limit(1);
      if (requestReplay) {
        if (
          requestReplay.gameId === input.gameId &&
          requestReplay.participantId === participant.id &&
          requestReplay.decision === input.decision
        ) {
          return;
        }
        throw new AppError(
          "ARCHIVE_CONSENT_CONFLICT",
          "这次保存选择已经处理，请勿重复修改。",
          409,
        );
      }

      const [archive] = await transaction
        .select()
        .from(echoArchives)
        .where(eq(echoArchives.sourceGameId, input.gameId))
        .limit(1)
        .for("update");
      if (
        !archive ||
        archive.status !== "pending" ||
        archive.consentExpiresAt <= now
      ) {
        throw new AppError(
          "ARCHIVE_CONSENT_UNAVAILABLE",
          "这局对话暂时无法保存，请继续体验其他对局。",
          409,
        );
      }

      const [existing] = await transaction
        .select()
        .from(echoConsents)
        .where(
          and(
            eq(echoConsents.gameId, input.gameId),
            eq(echoConsents.participantId, participant.id),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.decision === input.decision) return;
        throw new AppError(
          "ARCHIVE_CONSENT_LOCKED",
          "你的保存选择已经锁定，不能再次修改。",
          409,
        );
      }

      await transaction.insert(echoConsents).values({
        id: randomUUID(),
        gameId: input.gameId,
        participantId: participant.id,
        decision: input.decision,
        clientRequestId: input.clientRequestId,
        decidedAt: now,
      });
      if (input.decision === "decline") {
        await transaction
          .update(echoArchives)
          .set({ status: "rejected" })
          .where(eq(echoArchives.id, archive.id));
        return;
      }

      const participantRows = await transaction
        .select()
        .from(gameParticipants)
        .where(eq(gameParticipants.gameId, input.gameId));
      const consentRows = await transaction
        .select()
        .from(echoConsents)
        .where(eq(echoConsents.gameId, input.gameId));
      if (
        participantRows.length !== 2 ||
        consentRows.length !== participantRows.length ||
        consentRows.some((consent) => consent.decision !== "approve")
      ) {
        return;
      }
      await this.materializeArchive(transaction, archive.id, input.gameId, now);
    });
  }

  async withdrawForReport(gameId: string, now = this.now()): Promise<void> {
    await this.db
      .update(echoArchives)
      .set({
        status: "withdrawn",
        withdrawnAt: new Date(now),
      })
      .where(
        and(
          eq(echoArchives.sourceGameId, gameId),
          inArray(echoArchives.status, ["pending", "available"]),
        ),
      );
  }

  async createAssignment(
    reviewerUserId: string,
    nowValue = this.now(),
  ): Promise<EchoAssignmentResponse> {
    const now = new Date(nowValue);
    return this.db.transaction(async (transaction) => {
      const [active] = await transaction
        .select()
        .from(echoAssignments)
        .innerJoin(
          echoArchives,
          eq(echoAssignments.archiveId, echoArchives.id),
        )
        .where(
          and(
            eq(echoAssignments.reviewerUserId, reviewerUserId),
            isNull(echoAssignments.completedAt),
            gt(echoAssignments.expiresAt, now),
            eq(echoArchives.status, "available"),
          ),
        )
        .orderBy(asc(echoAssignments.assignedAt))
        .limit(1);
      if (active) {
        return this.assignmentResponse(
          transaction,
          active.echo_assignments,
          active.echo_archives.durationMs,
          nowValue,
        );
      }

      const selfSource = transaction
        .select({ one: sql<number>`1` })
        .from(echoArchiveSources)
        .where(
          and(
            eq(echoArchiveSources.archiveId, echoArchives.id),
            eq(echoArchiveSources.sourceUserId, reviewerUserId),
          ),
        );
      const priorAssignment = transaction
        .select({ one: sql<number>`1` })
        .from(echoAssignments)
        .where(
          and(
            eq(echoAssignments.archiveId, echoArchives.id),
            eq(echoAssignments.reviewerUserId, reviewerUserId),
          ),
        );
      const reported = transaction
        .select({ one: sql<number>`1` })
        .from(reports)
        .where(eq(reports.gameId, echoArchives.sourceGameId));
      const [archive] = await transaction
        .select()
        .from(echoArchives)
        .where(
          and(
            eq(echoArchives.status, "available"),
            notExists(selfSource),
            notExists(priorAssignment),
            notExists(reported),
          ),
        )
        .orderBy(sql`random()`)
        .limit(1)
        .for("update", { skipLocked: true });
      if (!archive) {
        throw new AppError(
          "ECHO_ARCHIVE_UNAVAILABLE",
          "暂时没有新的回声档案，请稍后再来看看。",
          404,
        );
      }
      const [assignment] = await transaction
        .insert(echoAssignments)
        .values({
          id: randomUUID(),
          archiveId: archive.id,
          reviewerUserId,
          assignedAt: now,
          expiresAt: new Date(nowValue + ASSIGNMENT_TTL_MS),
        })
        .returning();
      if (!assignment) {
        throw new Error("创建回声档案任务失败。");
      }
      return this.assignmentResponse(
        transaction,
        assignment,
        archive.durationMs,
        nowValue,
      );
    });
  }

  async getAssignment(
    assignmentId: string,
    reviewerUserId: string,
    nowValue = this.now(),
  ): Promise<EchoAssignmentResponse> {
    const [row] = await this.db
      .select()
      .from(echoAssignments)
      .innerJoin(
        echoArchives,
        eq(echoAssignments.archiveId, echoArchives.id),
      )
      .where(
        and(
          eq(echoAssignments.id, assignmentId),
          eq(echoAssignments.reviewerUserId, reviewerUserId),
          isNull(echoAssignments.completedAt),
          eq(echoArchives.status, "available"),
        ),
      )
      .limit(1);
    if (!row || row.echo_assignments.expiresAt.getTime() <= nowValue) {
      throw new AppError(
        "ECHO_ASSIGNMENT_UNAVAILABLE",
        "这份档案已经过期或不可用，请领取新的档案。",
        409,
      );
    }
    return this.assignmentResponse(
      this.db,
      row.echo_assignments,
      row.echo_archives.durationMs,
      nowValue,
    );
  }

  async submitJudgment(
    assignmentId: string,
    reviewerUserId: string,
    input: SubmitEchoJudgmentRequest,
    nowValue = this.now(),
  ): Promise<SubmitEchoJudgmentResponse> {
    const now = new Date(nowValue);
    return this.db.transaction(async (transaction) => {
      const [idempotent] = await transaction
        .select()
        .from(echoJudgments)
        .where(eq(echoJudgments.clientRequestId, input.clientRequestId))
        .limit(1);
      if (idempotent) {
        if (
          idempotent.assignmentId !== assignmentId ||
          idempotent.reviewerUserId !== reviewerUserId
        ) {
          throw new AppError(
            "ECHO_JUDGMENT_CONFLICT",
            "这次判读请求已经用于其他档案。",
            409,
          );
        }
        return this.judgmentResponse(transaction, idempotent);
      }

      const [row] = await transaction
        .select()
        .from(echoAssignments)
        .innerJoin(
          echoArchives,
          eq(echoAssignments.archiveId, echoArchives.id),
        )
        .where(
          and(
            eq(echoAssignments.id, assignmentId),
            eq(echoAssignments.reviewerUserId, reviewerUserId),
          ),
        )
        .limit(1)
        .for("update");
      if (
        !row ||
        row.echo_archives.status !== "available" ||
        row.echo_assignments.expiresAt <= now ||
        row.echo_assignments.completedAt
      ) {
        throw new AppError(
          "ECHO_ASSIGNMENT_UNAVAILABLE",
          "这份档案已经结束或不可用，请领取新的档案。",
          409,
        );
      }

      const sources = await transaction
        .select()
        .from(echoArchiveSources)
        .where(eq(echoArchiveSources.archiveId, row.echo_archives.id))
        .orderBy(asc(echoArchiveSources.publicSeat));
      const sourceA = sources.find((source) => source.publicSeat === 0);
      const sourceB = sources.find((source) => source.publicSeat === 1);
      if (!sourceA || !sourceB) {
        throw new Error("回声档案身份映射不完整。");
      }
      const correctA = input.guessA === sourceA.identityType;
      const correctB = input.guessB === sourceB.identityType;
      const correctCount = Number(correctA) + Number(correctB);
      const bothCorrect = correctCount === 2;
      const scoreDelta = bothCorrect ? 10 : correctCount === 1 ? 4 : 0;
      const confidenceCalibration = Math.round(
        ((correctA ? input.confidenceA : 100 - input.confidenceA) +
          (correctB ? input.confidenceB : 100 - input.confidenceB)) /
          2,
      );
      const [judgment] = await transaction
        .insert(echoJudgments)
        .values({
          id: randomUUID(),
          assignmentId,
          archiveId: row.echo_archives.id,
          reviewerUserId,
          guessA: input.guessA,
          confidenceA: input.confidenceA,
          guessB: input.guessB,
          confidenceB: input.confidenceB,
          correctCount,
          bothCorrect,
          scoreDelta,
          confidenceCalibration,
          clientRequestId: input.clientRequestId,
          submittedAt: now,
        })
        .returning();
      if (!judgment) throw new Error("保存回声判读失败。");

      await transaction
        .update(echoAssignments)
        .set({ completedAt: now })
        .where(eq(echoAssignments.id, assignmentId));
      await transaction
        .insert(echoReviewerStats)
        .values({
          userId: reviewerUserId,
          reviewsPlayed: 1,
          identitiesCorrect: correctCount,
          perfectJudgments: bothCorrect ? 1 : 0,
          score: scoreDelta,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: echoReviewerStats.userId,
          set: {
            reviewsPlayed: sql`${echoReviewerStats.reviewsPlayed} + 1`,
            identitiesCorrect: sql`${echoReviewerStats.identitiesCorrect} + ${correctCount}`,
            perfectJudgments: sql`${echoReviewerStats.perfectJudgments} + ${bothCorrect ? 1 : 0}`,
            score: sql`${echoReviewerStats.score} + ${scoreDelta}`,
            updatedAt: now,
          },
        });
      return this.judgmentResponse(transaction, judgment);
    });
  }

  async getReviewerRecords(
    reviewerUserId: string,
  ): Promise<EchoRecordsResponse> {
    const [statsRows, judgmentRows] = await Promise.all([
      this.db
        .select()
        .from(echoReviewerStats)
        .where(eq(echoReviewerStats.userId, reviewerUserId))
        .limit(1),
      this.db
        .select({
          judgment: echoJudgments,
          durationMs: echoArchives.durationMs,
        })
        .from(echoJudgments)
        .innerJoin(
          echoArchives,
          eq(echoJudgments.archiveId, echoArchives.id),
        )
        .where(eq(echoJudgments.reviewerUserId, reviewerUserId))
        .orderBy(
          desc(echoJudgments.submittedAt),
          desc(echoJudgments.id),
        )
        .limit(MAX_REVIEWER_RECORDS),
    ]);
    const stats = statsRows[0];
    const publicStats = {
      reviewsPlayed: stats?.reviewsPlayed ?? 0,
      identitiesCorrect: stats?.identitiesCorrect ?? 0,
      perfectJudgments: stats?.perfectJudgments ?? 0,
      score: stats?.score ?? 0,
    };
    if (judgmentRows.length === 0) {
      return { stats: publicStats, records: [] };
    }

    const archiveIds = [
      ...new Set(judgmentRows.map((row) => row.judgment.archiveId)),
    ];
    const [sourceRows, visibleMessageRows] = await Promise.all([
      this.db
        .select({
          archiveId: echoArchiveSources.archiveId,
          publicSeat: echoArchiveSources.publicSeat,
          identityType: echoArchiveSources.identityType,
        })
        .from(echoArchiveSources)
        .where(inArray(echoArchiveSources.archiveId, archiveIds)),
      this.db
        .select({ archiveId: echoArchiveEvents.archiveId })
        .from(echoArchiveEvents)
        .where(
          and(
            inArray(echoArchiveEvents.archiveId, archiveIds),
            eq(echoArchiveEvents.eventType, "message_visible"),
          ),
        ),
    ]);
    const identitiesByArchive = new Map<
      string,
      Partial<Record<"A" | "B", "human" | "ai">>
    >();
    for (const source of sourceRows) {
      const identities = identitiesByArchive.get(source.archiveId) ?? {};
      identities[publicActor(source.publicSeat)] = source.identityType;
      identitiesByArchive.set(source.archiveId, identities);
    }
    const messageCountByArchive = new Map<string, number>();
    for (const event of visibleMessageRows) {
      messageCountByArchive.set(
        event.archiveId,
        (messageCountByArchive.get(event.archiveId) ?? 0) + 1,
      );
    }

    const records: EchoRecordsResponse["records"] = [];
    for (const row of judgmentRows) {
      const judgment = row.judgment;
      const identities = identitiesByArchive.get(judgment.archiveId);
      if (!identities?.A || !identities.B) continue;
      records.push({
        id: judgment.id,
        submittedAt: judgment.submittedAt.toISOString(),
        identities: { A: identities.A, B: identities.B },
        guesses: { A: judgment.guessA, B: judgment.guessB },
        confidence: {
          A: judgment.confidenceA,
          B: judgment.confidenceB,
        },
        correct: {
          A: judgment.guessA === identities.A,
          B: judgment.guessB === identities.B,
        },
        correctCount: judgment.correctCount,
        bothCorrect: judgment.bothCorrect,
        scoreDelta: judgment.scoreDelta,
        confidenceCalibration: judgment.confidenceCalibration,
        durationMs: row.durationMs,
        messageCount:
          messageCountByArchive.get(judgment.archiveId) ?? 0,
      });
    }
    return { stats: publicStats, records };
  }

  async listComments(
    assignmentId: string,
    reviewerUserId: string,
  ): Promise<EchoCommentsResponse> {
    const context = await this.completedReviewerContext(
      this.db,
      assignmentId,
      reviewerUserId,
    );
    const rows = await this.db
      .select({
        comment: echoComments,
        authorAlias: echoCommentAuthors.alias,
        authorUserId: echoCommentAuthors.reviewerUserId,
      })
      .from(echoComments)
      .innerJoin(
        echoCommentAuthors,
        eq(echoComments.authorId, echoCommentAuthors.id),
      )
      .where(eq(echoComments.archiveId, context.archiveId))
      .orderBy(desc(echoComments.createdAt), desc(echoComments.id))
      .limit(MAX_COMMENTS_PER_ARCHIVE);
    if (rows.length === 0) {
      return { comments: [], countsByEventSequence: {} };
    }

    const eventRows = await this.db
      .select({
        id: echoArchiveEvents.id,
        eventSequence: echoArchiveEvents.eventSequence,
      })
      .from(echoArchiveEvents)
      .where(eq(echoArchiveEvents.archiveId, context.archiveId));
    const sequenceByEventId = new Map(
      eventRows.map((event) => [event.id, event.eventSequence]),
    );
    const commentIds = rows.map((row) => row.comment.id);
    const likes = await this.db
      .select()
      .from(echoCommentLikes)
      .where(inArray(echoCommentLikes.commentId, commentIds));
    const likeCounts = new Map<string, number>();
    const likedByReviewer = new Set<string>();
    for (const like of likes) {
      likeCounts.set(
        like.commentId,
        (likeCounts.get(like.commentId) ?? 0) + 1,
      );
      if (like.reviewerUserId === reviewerUserId) {
        likedByReviewer.add(like.commentId);
      }
    }

    const comments: EchoComment[] = [];
    const countsByEventSequence: Record<string, number> = {};
    for (const row of rows) {
      const eventSequence = sequenceByEventId.get(
        row.comment.archiveEventId,
      );
      if (!eventSequence) continue;
      comments.push({
        id: row.comment.id,
        eventSequence,
        authorAlias: row.authorAlias,
        content: row.comment.content,
        createdAt: row.comment.createdAt.toISOString(),
        likeCount: likeCounts.get(row.comment.id) ?? 0,
        likedByMe: likedByReviewer.has(row.comment.id),
        mine: row.authorUserId === reviewerUserId,
      });
      const key = String(eventSequence);
      countsByEventSequence[key] =
        (countsByEventSequence[key] ?? 0) + 1;
    }
    return { comments, countsByEventSequence };
  }

  async createComment(
    assignmentId: string,
    reviewerUserId: string,
    input: SubmitEchoCommentRequest,
  ): Promise<EchoComment> {
    // 权限检查必须先于正文审核，避免未完成判定者借接口写入或探测批注状态。
    await this.completedReviewerContext(
      this.db,
      assignmentId,
      reviewerUserId,
    );
    const content = input.content.trim();
    if ([...content].length < 2 || [...content].length > 200) {
      throw new AppError(
        "INVALID_ECHO_COMMENT",
        "回声批注需要填写 2–200 个字符。",
        400,
      );
    }

    const moderation = this.moderation.evaluate({
      text: content,
      surface: "ECHO_COMMENT",
      audit: { actorId: reviewerUserId },
    });
    await this.db.insert(moderationEvents).values({
      id: moderation.audit.eventId,
      userId: reviewerUserId,
      source: "echo_comment",
      category: moderation.categories[0] ?? "NONE",
      decision:
        moderation.action === "ALLOW"
          ? "allow"
          : moderation.action === "REDACT"
            ? "replace"
            : moderation.action === "BLOCK"
              ? "block"
              : "terminate",
      riskScore:
        moderation.action === "TERMINATE"
          ? 100
          : moderation.action === "BLOCK"
            ? 80
            : moderation.action === "REDACT"
              ? 30
              : 0,
      contentHash: moderation.audit.contentSha256,
      metadata: {
        matchedRules: moderation.matches.map((match) => match.ruleId),
      },
      createdAt: new Date(moderation.audit.occurredAt),
    });
    if (
      moderation.action === "BLOCK" ||
      moderation.action === "TERMINATE"
    ) {
      throw new AppError(
        "ECHO_COMMENT_BLOCKED",
        moderation.userMessage ?? "这条批注不适合公开展示，请换一种说法。",
        400,
      );
    }

    return this.db.transaction(async (transaction) => {
      const context = await this.completedReviewerContext(
        transaction,
        assignmentId,
        reviewerUserId,
      );
      // 串行化同一档案的计数与插入，避免并发请求穿透 5/500 条硬上限。
      await transaction
        .select({ id: echoArchives.id })
        .from(echoArchives)
        .where(eq(echoArchives.id, context.archiveId))
        .limit(1)
        .for("update");
      const [idempotent] = await transaction
        .select({
          comment: echoComments,
          authorAlias: echoCommentAuthors.alias,
          authorUserId: echoCommentAuthors.reviewerUserId,
          eventSequence: echoArchiveEvents.eventSequence,
        })
        .from(echoComments)
        .innerJoin(
          echoCommentAuthors,
          eq(echoComments.authorId, echoCommentAuthors.id),
        )
        .innerJoin(
          echoArchiveEvents,
          eq(echoComments.archiveEventId, echoArchiveEvents.id),
        )
        .where(eq(echoComments.clientRequestId, input.clientRequestId))
        .limit(1);
      if (idempotent) {
        if (
          idempotent.comment.archiveId !== context.archiveId ||
          idempotent.comment.authorAssignmentId !== assignmentId ||
          idempotent.authorUserId !== reviewerUserId ||
          idempotent.eventSequence !== input.eventSequence ||
          idempotent.comment.content !== moderation.text
        ) {
          throw new AppError(
            "ECHO_COMMENT_CONFLICT",
            "这次批注请求已经用于其他内容。",
            409,
          );
        }
        return this.commentResponse(
          transaction,
          idempotent.comment,
          idempotent.authorAlias,
          reviewerUserId,
          idempotent.eventSequence,
          true,
        );
      }

      const [target] = await transaction
        .select()
        .from(echoArchiveEvents)
        .where(
          and(
            eq(echoArchiveEvents.archiveId, context.archiveId),
            eq(echoArchiveEvents.eventSequence, input.eventSequence),
            eq(echoArchiveEvents.eventType, "message_visible"),
          ),
        )
        .limit(1);
      if (!target) {
        throw new AppError(
          "ECHO_COMMENT_TARGET_INVALID",
          "只能对这份档案中已经展示的消息添加批注。",
          400,
        );
      }

      const author = await this.ensureCommentAuthor(
        transaction,
        context.archiveId,
        reviewerUserId,
      );
      const reviewerComments = await transaction
        .select({ id: echoComments.id })
        .from(echoComments)
        .where(
          and(
            eq(echoComments.archiveId, context.archiveId),
            eq(echoComments.authorId, author.id),
          ),
        )
        .limit(MAX_COMMENTS_PER_REVIEWER_PER_ARCHIVE);
      if (
        reviewerComments.length >=
        MAX_COMMENTS_PER_REVIEWER_PER_ARCHIVE
      ) {
        throw new AppError(
          "ECHO_COMMENT_LIMIT_REACHED",
          "每份档案最多可以留下 5 条批注喵。",
          429,
        );
      }
      const archiveComments = await transaction
        .select({ id: echoComments.id })
        .from(echoComments)
        .where(eq(echoComments.archiveId, context.archiveId))
        .limit(MAX_COMMENTS_PER_ARCHIVE);
      if (archiveComments.length >= MAX_COMMENTS_PER_ARCHIVE) {
        throw new AppError(
          "ECHO_COMMENT_ARCHIVE_FULL",
          "这份档案的批注区已经满啦，请看看大家留下的回声吧。",
          409,
        );
      }

      const [comment] = await transaction
        .insert(echoComments)
        .values({
          id: randomUUID(),
          archiveId: context.archiveId,
          archiveEventId: target.id,
          authorId: author.id,
          authorAssignmentId: assignmentId,
          content: moderation.text,
          clientRequestId: input.clientRequestId,
          createdAt: new Date(this.now()),
        })
        .returning();
      if (!comment) throw new Error("保存回声批注失败。");
      return this.commentResponse(
        transaction,
        comment,
        author.alias,
        reviewerUserId,
        target.eventSequence,
        true,
      );
    });
  }

  async setCommentLike(
    assignmentId: string,
    reviewerUserId: string,
    commentId: string,
    liked: boolean,
  ): Promise<EchoCommentLikeResponse> {
    return this.db.transaction(async (transaction) => {
      const context = await this.completedReviewerContext(
        transaction,
        assignmentId,
        reviewerUserId,
      );
      const [row] = await transaction
        .select({
          comment: echoComments,
          authorUserId: echoCommentAuthors.reviewerUserId,
        })
        .from(echoComments)
        .innerJoin(
          echoCommentAuthors,
          eq(echoComments.authorId, echoCommentAuthors.id),
        )
        .where(
          and(
            eq(echoComments.id, commentId),
            eq(echoComments.archiveId, context.archiveId),
          ),
        )
        .limit(1);
      if (!row) {
        throw new AppError(
          "ECHO_COMMENT_UNAVAILABLE",
          "这条批注不存在或已经被删除。",
          404,
        );
      }
      if (row.authorUserId === reviewerUserId) {
        throw new AppError(
          "ECHO_COMMENT_SELF_LIKE",
          "不能给自己的批注点赞喵。",
          409,
        );
      }
      if (liked) {
        await transaction
          .insert(echoCommentLikes)
          .values({
            commentId,
            reviewerUserId,
            createdAt: new Date(this.now()),
          })
          .onConflictDoNothing();
      } else {
        await transaction
          .delete(echoCommentLikes)
          .where(
            and(
              eq(echoCommentLikes.commentId, commentId),
              eq(echoCommentLikes.reviewerUserId, reviewerUserId),
            ),
          );
      }
      const likeCount = await this.commentLikeCount(transaction, commentId);
      return { commentId, liked, likeCount };
    });
  }

  async deleteComment(
    assignmentId: string,
    reviewerUserId: string,
    commentId: string,
  ): Promise<DeleteEchoCommentResponse> {
    return this.db.transaction(async (transaction) => {
      const context = await this.completedReviewerContext(
        transaction,
        assignmentId,
        reviewerUserId,
      );
      const [owned] = await transaction
        .select({ id: echoComments.id })
        .from(echoComments)
        .innerJoin(
          echoCommentAuthors,
          eq(echoComments.authorId, echoCommentAuthors.id),
        )
        .where(
          and(
            eq(echoComments.id, commentId),
            eq(echoComments.archiveId, context.archiveId),
            eq(echoCommentAuthors.reviewerUserId, reviewerUserId),
          ),
        )
        .limit(1);
      if (!owned) {
        throw new AppError(
          "ECHO_COMMENT_DELETE_FORBIDDEN",
          "只能删除自己在这份档案中留下的批注。",
          403,
        );
      }
      await transaction
        .delete(echoComments)
        .where(eq(echoComments.id, commentId));
      return { commentId, deleted: true };
    });
  }

  private async completedReviewerContext(
    database: Pick<AppDatabase, "select">,
    assignmentId: string,
    reviewerUserId: string,
  ): Promise<{ archiveId: string }> {
    const [row] = await database
      .select({
        archiveId: echoAssignments.archiveId,
      })
      .from(echoAssignments)
      .innerJoin(
        echoArchives,
        eq(echoAssignments.archiveId, echoArchives.id),
      )
      .innerJoin(
        echoJudgments,
        eq(echoJudgments.assignmentId, echoAssignments.id),
      )
      .where(
        and(
          eq(echoAssignments.id, assignmentId),
          eq(echoAssignments.reviewerUserId, reviewerUserId),
          eq(echoJudgments.reviewerUserId, reviewerUserId),
          eq(echoArchives.status, "available"),
        ),
      )
      .limit(1);
    if (!row) {
      throw new AppError(
        "ECHO_COMMENTS_LOCKED",
        "完成身份判断后，才可以查看和参与回声批注。",
        403,
      );
    }
    return row;
  }

  private async ensureCommentAuthor(
    database: Pick<AppDatabase, "select" | "insert">,
    archiveId: string,
    reviewerUserId: string,
  ): Promise<typeof echoCommentAuthors.$inferSelect> {
    const [existing] = await database
      .select()
      .from(echoCommentAuthors)
      .where(
        and(
          eq(echoCommentAuthors.archiveId, archiveId),
          eq(echoCommentAuthors.reviewerUserId, reviewerUserId),
        ),
      )
      .limit(1);
    if (existing) return existing;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = Number.parseInt(
        randomUUID().replaceAll("-", "").slice(0, 8),
        16,
      )
        .toString(36)
        .padStart(6, "0")
        .slice(-4)
        .toUpperCase();
      const [created] = await database
        .insert(echoCommentAuthors)
        .values({
          id: randomUUID(),
          archiveId,
          reviewerUserId,
          alias: `鉴证官 ${code}`,
          createdAt: new Date(this.now()),
        })
        .onConflictDoNothing()
        .returning();
      if (created) return created;
      const [concurrent] = await database
        .select()
        .from(echoCommentAuthors)
        .where(
          and(
            eq(echoCommentAuthors.archiveId, archiveId),
            eq(echoCommentAuthors.reviewerUserId, reviewerUserId),
          ),
        )
        .limit(1);
      if (concurrent) return concurrent;
    }
    throw new Error("生成档案内匿名鉴证官代号失败。");
  }

  private async commentLikeCount(
    database: Pick<AppDatabase, "select">,
    commentId: string,
  ): Promise<number> {
    const [row] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(echoCommentLikes)
      .where(eq(echoCommentLikes.commentId, commentId));
    return Number(row?.count ?? 0);
  }

  private async commentResponse(
    database: Pick<AppDatabase, "select">,
    comment: typeof echoComments.$inferSelect,
    authorAlias: string,
    reviewerUserId: string,
    eventSequence: number,
    mine: boolean,
  ): Promise<EchoComment> {
    const [likeCount, likedRows] = await Promise.all([
      this.commentLikeCount(database, comment.id),
      database
        .select({ commentId: echoCommentLikes.commentId })
        .from(echoCommentLikes)
        .where(
          and(
            eq(echoCommentLikes.commentId, comment.id),
            eq(echoCommentLikes.reviewerUserId, reviewerUserId),
          ),
        )
        .limit(1),
    ]);
    return {
      id: comment.id,
      eventSequence,
      authorAlias,
      content: comment.content,
      createdAt: comment.createdAt.toISOString(),
      likeCount,
      likedByMe: likedRows.length > 0,
      mine,
    };
  }

  private async materializeArchive(
    transaction: Parameters<
      Parameters<AppDatabase["transaction"]>[0]
    >[0],
    archiveId: string,
    gameId: string,
    now: Date,
  ): Promise<void> {
    const [reported, unsafe] = await Promise.all([
      transaction
        .select({ id: reports.id })
        .from(reports)
        .where(eq(reports.gameId, gameId))
        .limit(1),
      transaction
        .select({ id: moderationEvents.id })
        .from(moderationEvents)
        .where(
          and(
            eq(moderationEvents.gameId, gameId),
            inArray(moderationEvents.decision, ["block", "terminate"]),
          ),
        )
        .limit(1),
    ]);
    if (reported.length > 0 || unsafe.length > 0) {
      await transaction
        .update(echoArchives)
        .set({ status: "withdrawn", withdrawnAt: now })
        .where(eq(echoArchives.id, archiveId));
      return;
    }

    const [game] = await transaction
      .select()
      .from(games)
      .where(eq(games.id, gameId))
      .limit(1);
    const participants = await transaction
      .select()
      .from(gameParticipants)
      .where(eq(gameParticipants.gameId, gameId))
      .orderBy(asc(gameParticipants.seat));
    if (!game?.startedAt || participants.length !== 2) {
      throw new Error("无法物化缺少开局时间或参与者的回声档案。");
    }
    if (
      participants.every(
        (participant) => participant.identityType === "ai",
      )
    ) {
      throw new Error("首版不接受 AI-AI 回声档案。");
    }

    const sourceOrder =
      this.random() < 0.5
        ? participants
        : [participants[1]!, participants[0]!];
    for (const [publicSeat, participant] of sourceOrder.entries()) {
      await transaction.insert(echoArchiveSources).values({
        archiveId,
        publicSeat,
        sourceParticipantId: participant.id,
        sourceUserId: participant.userId,
        identityType: participant.identityType,
      });
    }
    const publicSeatByParticipant = new Map(
      sourceOrder.map((participant, publicSeat) => [
        participant.id,
        publicSeat,
      ]),
    );
    const timeline = await transaction
      .select({
        event: gameTimelineEvents,
        content: messages.content,
        moderated: messages.moderated,
      })
      .from(gameTimelineEvents)
      .leftJoin(messages, eq(gameTimelineEvents.messageId, messages.id))
      .where(eq(gameTimelineEvents.gameId, gameId))
      .orderBy(asc(gameTimelineEvents.eventSequence));
    let publicSequence = 0;
    for (const row of timeline) {
      if (!row.event.actorParticipantId) {
        continue;
      }
      const publicSeat = publicSeatByParticipant.get(
        row.event.actorParticipantId,
      );
      if (
        publicSeat === undefined ||
        !["typing_start", "typing_stop", "message_visible"].includes(
          row.event.eventType,
        )
      ) {
        continue;
      }
      publicSequence += 1;
      await transaction.insert(echoArchiveEvents).values({
        id: randomUUID(),
        archiveId,
        eventSequence: publicSequence,
        eventType: row.event.eventType,
        publicSeat,
        offsetMs: Math.max(
          0,
          row.event.occurredAt.getTime() - game.startedAt.getTime(),
        ),
        content:
          row.event.eventType === "message_visible"
            ? row.content ?? ""
            : null,
        moderated:
          row.event.eventType === "message_visible"
            ? row.moderated ?? false
            : false,
      });
    }
    if (publicSequence === 0) {
      await transaction
        .update(echoArchives)
        .set({ status: "rejected" })
        .where(eq(echoArchives.id, archiveId));
      return;
    }
    await transaction
      .update(echoArchives)
      .set({ status: "available", publishedAt: now })
      .where(eq(echoArchives.id, archiveId));
  }

  private async assignmentResponse(
    database: Pick<AppDatabase, "select">,
    assignment: EchoAssignmentRow,
    durationMs: number,
    nowValue: number,
  ): Promise<EchoAssignmentResponse> {
    const events = await database
      .select()
      .from(echoArchiveEvents)
      .where(eq(echoArchiveEvents.archiveId, assignment.archiveId))
      .orderBy(asc(echoArchiveEvents.eventSequence));
    return {
      assignmentId: assignment.id,
      archiveId: assignment.archiveId,
      status: "active",
      expiresInSeconds: Math.max(
        0,
        Math.floor((assignment.expiresAt.getTime() - nowValue) / 1_000),
      ),
      durationMs,
      events: events.map((event) => ({
        sequence: event.eventSequence,
        type:
          event.eventType === "typing_start"
            ? "typing.start"
            : event.eventType === "typing_stop"
              ? "typing.stop"
              : "message.visible",
        actor: publicActor(event.publicSeat),
        offsetMs: event.offsetMs,
        ...(event.eventType === "message_visible"
          ? {
              content: event.content ?? "",
              moderated: event.moderated,
            }
          : {}),
      })),
    };
  }

  private async judgmentResponse(
    database: Pick<AppDatabase, "select">,
    judgment: typeof echoJudgments.$inferSelect,
  ): Promise<SubmitEchoJudgmentResponse> {
    const [sources, statsRows] = await Promise.all([
      database
        .select()
        .from(echoArchiveSources)
        .where(eq(echoArchiveSources.archiveId, judgment.archiveId))
        .orderBy(asc(echoArchiveSources.publicSeat)),
      database
        .select()
        .from(echoReviewerStats)
        .where(eq(echoReviewerStats.userId, judgment.reviewerUserId))
        .limit(1),
    ]);
    const sourceA = sources.find((source) => source.publicSeat === 0);
    const sourceB = sources.find((source) => source.publicSeat === 1);
    const stats = statsRows[0];
    if (!sourceA || !sourceB || !stats) {
      throw new Error("回声档案结算数据不完整。");
    }
    return {
      completed: true,
      identities: {
        A: sourceA.identityType,
        B: sourceB.identityType,
      },
      correct: {
        A: judgment.guessA === sourceA.identityType,
        B: judgment.guessB === sourceB.identityType,
      },
      correctCount: judgment.correctCount,
      bothCorrect: judgment.bothCorrect,
      scoreDelta: judgment.scoreDelta,
      confidenceCalibration: judgment.confidenceCalibration,
      stats: {
        reviewsPlayed: stats.reviewsPlayed,
        identitiesCorrect: stats.identitiesCorrect,
        perfectJudgments: stats.perfectJudgments,
        score: stats.score,
      },
    };
  }
}
