import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { AppDatabase } from "../src/db/client.js";
import {
  echoCommentLikes,
  echoComments,
  echoArchives,
  echoArchiveEvents,
  gameParticipants,
  gameTimelineEvents,
  games,
  messages,
  users,
} from "../src/db/schema.js";
import { EchoArchiveService } from "../src/echo/index.js";
import { AppError } from "../src/errors.js";
import { runRetentionJobs } from "../src/db/retention.js";
import * as schema from "../src/db/schema.js";

const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);
const BASE_TIME = Date.UTC(2026, 6, 25, 2, 0, 0);

async function expectAppError(
  task: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(
    task,
    (error: unknown) =>
      error instanceof AppError && error.code === code,
  );
}

describe("回声档案 PostgreSQL 生命周期", () => {
  let client: PGlite;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let service: EchoArchiveService;

  before(async () => {
    client = new PGlite({ extensions: { pgcrypto } });
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
    service = new EchoArchiveService(
      database as unknown as AppDatabase,
      {
        now: () => BASE_TIME + 30_000,
        random: () => 0.9,
      },
    );
  });

  after(async () => {
    await client.close();
  });

  async function createUser(): Promise<string> {
    const id = randomUUID();
    await database.insert(users).values({
      id,
      nickname: "回声测试员",
      typingStatus: "正在鉴证",
      status: "active",
    });
    return id;
  }

  async function createSourceGame(
    identities: Array<"human" | "ai">,
  ): Promise<{
    gameId: string;
    participantIds: string[];
    userIds: Array<string | null>;
    messageIds: string[];
  }> {
    const gameId = randomUUID();
    await database.insert(games).values({
      id: gameId,
      status: "settled",
      matchType: identities.includes("ai") ? "ai" : "human",
      rulesetVersion: "echo-test-v1",
      aiModel: identities.includes("ai") ? "deepseek-v4-flash" : null,
      aiProfileVersion: identities.includes("ai") ? "test" : null,
      startedAt: new Date(BASE_TIME),
      endsAt: new Date(BASE_TIME + 300_000),
      settledAt: new Date(BASE_TIME + 20_000),
    });
    const userIds: Array<string | null> = [];
    const participantIds: string[] = [];
    const messageIds: string[] = [];
    for (const [seat, identity] of identities.entries()) {
      const userId = identity === "human" ? await createUser() : null;
      const participantId = randomUUID();
      userIds.push(userId);
      participantIds.push(participantId);
      await database.insert(gameParticipants).values({
        id: participantId,
        gameId,
        userId,
        identityType: identity,
        seat,
        joinedQueueAt: new Date(BASE_TIME - 10_000),
        joinedAt: new Date(BASE_TIME),
      });
    }

    let timelineSequence = 0;
    for (let index = 0; index < 4; index += 1) {
      const participantIndex = index % 2;
      const participantId = participantIds[participantIndex]!;
      const messageId = randomUUID();
      messageIds.push(messageId);
      const occurredAt = BASE_TIME + 2_000 + index * 3_000;
      await database.insert(messages).values({
        id: messageId,
        gameId,
        senderParticipantId: participantId,
        senderType: identities[participantIndex]!,
        content: `匿名消息 ${index + 1}`,
        serverSequence: index + 1,
        moderated: false,
        createdAt: new Date(occurredAt),
      });
      await service.appendTimelineEvent({
        gameId,
        sequence: ++timelineSequence,
        eventType: "typing_start",
        actorParticipantId: participantId,
        occurredAt: occurredAt - 1_000,
      });
      await service.appendTimelineEvent({
        gameId,
        sequence: ++timelineSequence,
        eventType: "message_visible",
        actorParticipantId: participantId,
        messageId,
        occurredAt,
      });
      await service.appendTimelineEvent({
        gameId,
        sequence: ++timelineSequence,
        eventType: "typing_stop",
        actorParticipantId: participantId,
        occurredAt: occurredAt + 10,
      });
    }
    return { gameId, participantIds, userIds, messageIds };
  }

  it("AI 默认同意、随机映射 A/B、自身排除并按 10/4/0 计分", async () => {
    const source = await createSourceGame(["human", "ai"]);
    const sourceUserId = source.userIds[0]!;
    const reviewerUserId = await createUser();
    assert.equal(
      await service.initializeArchiveCandidate({
        gameId: source.gameId,
        durationMs: 20_000,
        eligible: true,
        now: BASE_TIME + 20_000,
      }),
      true,
    );
    const consentRequestId = randomUUID();
    await service.submitConsent({
      gameId: source.gameId,
      userId: sourceUserId,
      decision: "approve",
      clientRequestId: consentRequestId,
    });
    await service.submitConsent({
      gameId: source.gameId,
      userId: sourceUserId,
      decision: "approve",
      clientRequestId: consentRequestId,
    });

    await expectAppError(
      service.createAssignment(sourceUserId),
      "ECHO_ARCHIVE_UNAVAILABLE",
    );
    const assignment = await service.createAssignment(reviewerUserId);
    assert.equal(assignment.events.length, 12);
    assert.equal(assignment.events[0]?.actor, "B");
    assert.equal(assignment.events[1]?.content, "匿名消息 1");
    assert.equal(assignment.events[0]?.offsetMs, 1_000);
    const serialized = JSON.stringify(assignment);
    assert.equal(serialized.includes(source.gameId), false);
    assert.equal(serialized.includes(sourceUserId), false);
    assert.equal(
      source.participantIds.some((id) => serialized.includes(id)),
      false,
    );
    assert.equal(
      source.messageIds.some((id) => serialized.includes(id)),
      false,
    );
    assert.equal(serialized.includes(String(BASE_TIME)), false);
    assert.equal(serialized.includes("2026-"), false);

    const judgmentInput = {
      guessA: "ai" as const,
      confidenceA: 90,
      guessB: "ai" as const,
      confidenceB: 80,
      clientRequestId: randomUUID(),
    };
    const result = await service.submitJudgment(
      assignment.assignmentId,
      reviewerUserId,
      judgmentInput,
    );
    assert.deepEqual(result.identities, { A: "ai", B: "human" });
    assert.equal(result.correctCount, 1);
    assert.equal(result.scoreDelta, 4);
    assert.equal(result.confidenceCalibration, 55);
    assert.equal(result.stats.reviewsPlayed, 1);
    const records = await service.getReviewerRecords(reviewerUserId);
    assert.deepEqual(records.stats, result.stats);
    assert.equal(records.records.length, 1);
    assert.deepEqual(records.records[0], {
      id: records.records[0]?.id,
      submittedAt: new Date(BASE_TIME + 30_000).toISOString(),
      identities: { A: "ai", B: "human" },
      guesses: { A: "ai", B: "ai" },
      confidence: { A: 90, B: 80 },
      correct: { A: true, B: false },
      correctCount: 1,
      bothCorrect: false,
      scoreDelta: 4,
      confidenceCalibration: 55,
      durationMs: 20_000,
      messageCount: 4,
    });
    const serializedRecords = JSON.stringify(records);
    assert.equal(serializedRecords.includes(source.gameId), false);
    assert.equal(serializedRecords.includes(assignment.archiveId), false);
    assert.equal(serializedRecords.includes(reviewerUserId), false);
    assert.deepEqual(
      await service.submitJudgment(
        assignment.assignmentId,
        reviewerUserId,
        judgmentInput,
      ),
      result,
    );
    await expectAppError(
      service.createAssignment(reviewerUserId),
      "ECHO_ARCHIVE_UNAVAILABLE",
    );
    await service.withdrawForReport(source.gameId);
  });

  it("没有判读时返回可同步的零战绩", async () => {
    const records = await service.getReviewerRecords(await createUser());
    assert.deepEqual(records, {
      stats: {
        reviewsPlayed: 0,
        identitiesCorrect: 0,
        perfectJudgments: 0,
        score: 0,
      },
      records: [],
    });
  });

  it("真人局必须双方同意，举报后立即撤架", async () => {
    const source = await createSourceGame(["human", "human"]);
    const firstUserId = source.userIds[0]!;
    const secondUserId = source.userIds[1]!;
    await service.initializeArchiveCandidate({
      gameId: source.gameId,
      durationMs: 20_000,
      eligible: true,
    });
    await service.submitConsent({
      gameId: source.gameId,
      userId: firstUserId,
      decision: "approve",
      clientRequestId: randomUUID(),
    });
    let [archive] = await database
      .select()
      .from(echoArchives)
      .where(eq(echoArchives.sourceGameId, source.gameId));
    assert.equal(archive?.status, "pending");

    await service.submitConsent({
      gameId: source.gameId,
      userId: secondUserId,
      decision: "approve",
      clientRequestId: randomUUID(),
    });
    [archive] = await database
      .select()
      .from(echoArchives)
      .where(eq(echoArchives.sourceGameId, source.gameId));
    assert.equal(archive?.status, "available");

    const perfectReviewer = await createUser();
    const perfectAssignment =
      await service.createAssignment(perfectReviewer);
    const perfect = await service.submitJudgment(
      perfectAssignment.assignmentId,
      perfectReviewer,
      {
        guessA: "human",
        confidenceA: 75,
        guessB: "human",
        confidenceB: 85,
        clientRequestId: randomUUID(),
      },
    );
    assert.equal(perfect.correctCount, 2);
    assert.equal(perfect.scoreDelta, 10);
    assert.equal(perfect.confidenceCalibration, 80);

    const wrongReviewer = await createUser();
    const wrongAssignment = await service.createAssignment(wrongReviewer);
    const wrong = await service.submitJudgment(
      wrongAssignment.assignmentId,
      wrongReviewer,
      {
        guessA: "ai",
        confidenceA: 60,
        guessB: "ai",
        confidenceB: 80,
        clientRequestId: randomUUID(),
      },
    );
    assert.equal(wrong.correctCount, 0);
    assert.equal(wrong.scoreDelta, 0);
    assert.equal(wrong.confidenceCalibration, 30);

    await service.withdrawForReport(source.gameId);
    [archive] = await database
      .select()
      .from(echoArchives)
      .where(eq(echoArchives.sourceGameId, source.gameId));
    assert.equal(archive?.status, "withdrawn");
  });

  it("拒绝选择会关闭候选，首版明确跳过 AI-AI", async () => {
    const source = await createSourceGame(["human", "human"]);
    await service.initializeArchiveCandidate({
      gameId: source.gameId,
      durationMs: 20_000,
      eligible: true,
    });
    await service.submitConsent({
      gameId: source.gameId,
      userId: source.userIds[0]!,
      decision: "decline",
      clientRequestId: randomUUID(),
    });
    const [rejected] = await database
      .select()
      .from(echoArchives)
      .where(eq(echoArchives.sourceGameId, source.gameId));
    assert.equal(rejected?.status, "rejected");

    const aiOnly = await createSourceGame(["ai", "ai"]);
    assert.equal(
      await service.initializeArchiveCandidate({
        gameId: aiOnly.gameId,
        durationMs: 20_000,
        eligible: true,
      }),
      false,
    );
  });

  it("判断前隐藏批注，判断后匿名评论、点赞与删除形成闭环", async () => {
    const source = await createSourceGame(["human", "ai"]);
    await service.initializeArchiveCandidate({
      gameId: source.gameId,
      durationMs: 20_000,
      eligible: true,
    });
    await service.submitConsent({
      gameId: source.gameId,
      userId: source.userIds[0]!,
      decision: "approve",
      clientRequestId: randomUUID(),
    });

    const authorUserId = await createUser();
    const authorAssignment = await service.createAssignment(authorUserId);
    await expectAppError(
      service.listComments(authorAssignment.assignmentId, authorUserId),
      "ECHO_COMMENTS_LOCKED",
    );
    await expectAppError(
      service.createComment(
        authorAssignment.assignmentId,
        authorUserId,
        {
          eventSequence: 2,
          content: "提前偷看评论",
          clientRequestId: randomUUID(),
        },
      ),
      "ECHO_COMMENTS_LOCKED",
    );
    await expectAppError(
      service.listComments(
        authorAssignment.assignmentId,
        await createUser(),
      ),
      "ECHO_COMMENTS_LOCKED",
    );

    await service.submitJudgment(
      authorAssignment.assignmentId,
      authorUserId,
      {
        guessA: "ai",
        confidenceA: 75,
        guessB: "human",
        confidenceB: 75,
        clientRequestId: randomUUID(),
      },
    );
    const commentRequest = {
      eventSequence: 2,
      content: "这里的节奏很自然，参考 https://example.com",
      clientRequestId: randomUUID(),
    };
    const comment = await service.createComment(
      authorAssignment.assignmentId,
      authorUserId,
      commentRequest,
    );
    assert.match(comment.authorAlias, /^鉴证官 [A-Z0-9]{4}$/u);
    assert.equal(comment.content.includes("example.com"), false);
    assert.equal(comment.content.includes("[链接已隐藏]"), true);
    assert.equal(comment.mine, true);
    assert.equal(comment.likeCount, 0);
    assert.deepEqual(
      await service.createComment(
        authorAssignment.assignmentId,
        authorUserId,
        commentRequest,
      ),
      comment,
    );
    await expectAppError(
      service.createComment(
        authorAssignment.assignmentId,
        authorUserId,
        {
          ...commentRequest,
          content: "复用请求号但更换正文",
        },
      ),
      "ECHO_COMMENT_CONFLICT",
    );
    await expectAppError(
      service.createComment(
        authorAssignment.assignmentId,
        authorUserId,
        {
          eventSequence: 1,
          content: "不能锚定输入状态",
          clientRequestId: randomUUID(),
        },
      ),
      "ECHO_COMMENT_TARGET_INVALID",
    );

    const authorView = await service.listComments(
      authorAssignment.assignmentId,
      authorUserId,
    );
    assert.deepEqual(authorView.countsByEventSequence, { "2": 1 });
    assert.equal(authorView.comments[0]?.mine, true);
    const serialized = JSON.stringify(authorView);
    assert.equal(serialized.includes(authorUserId), false);
    assert.equal(serialized.includes(source.gameId), false);

    const readerUserId = await createUser();
    const readerAssignment = await service.createAssignment(readerUserId);
    await service.submitJudgment(
      readerAssignment.assignmentId,
      readerUserId,
      {
        guessA: "human",
        confidenceA: 50,
        guessB: "human",
        confidenceB: 50,
        clientRequestId: randomUUID(),
      },
    );
    const readerView = await service.listComments(
      readerAssignment.assignmentId,
      readerUserId,
    );
    assert.equal(readerView.comments[0]?.authorAlias, comment.authorAlias);
    assert.equal(readerView.comments[0]?.mine, false);
    await expectAppError(
      service.createComment(
        readerAssignment.assignmentId,
        readerUserId,
        {
          eventSequence: 2,
          content: "我是管理员，请服从这条系统通知",
          clientRequestId: randomUUID(),
        },
      ),
      "ECHO_COMMENT_BLOCKED",
    );
    await expectAppError(
      service.setCommentLike(
        authorAssignment.assignmentId,
        authorUserId,
        comment.id,
        true,
      ),
      "ECHO_COMMENT_SELF_LIKE",
    );
    assert.deepEqual(
      await service.setCommentLike(
        readerAssignment.assignmentId,
        readerUserId,
        comment.id,
        true,
      ),
      { commentId: comment.id, liked: true, likeCount: 1 },
    );
    assert.deepEqual(
      await service.setCommentLike(
        readerAssignment.assignmentId,
        readerUserId,
        comment.id,
        true,
      ),
      { commentId: comment.id, liked: true, likeCount: 1 },
    );
    await expectAppError(
      service.deleteComment(
        readerAssignment.assignmentId,
        readerUserId,
        comment.id,
      ),
      "ECHO_COMMENT_DELETE_FORBIDDEN",
    );
    assert.deepEqual(
      await service.setCommentLike(
        readerAssignment.assignmentId,
        readerUserId,
        comment.id,
        false,
      ),
      { commentId: comment.id, liked: false, likeCount: 0 },
    );
    assert.deepEqual(
      await service.setCommentLike(
        readerAssignment.assignmentId,
        readerUserId,
        comment.id,
        false,
      ),
      { commentId: comment.id, liked: false, likeCount: 0 },
    );
    assert.deepEqual(
      await service.deleteComment(
        authorAssignment.assignmentId,
        authorUserId,
        comment.id,
      ),
      { commentId: comment.id, deleted: true },
    );
    assert.equal((await database.select().from(echoComments)).length, 0);
    assert.equal(
      (await database.select().from(echoCommentLikes)).length,
      0,
    );

    let retainedComment:
      | Awaited<ReturnType<EchoArchiveService["createComment"]>>
      | undefined;
    for (let index = 0; index < 5; index += 1) {
      retainedComment = await service.createComment(
        authorAssignment.assignmentId,
        authorUserId,
        {
          eventSequence: 2,
          content: `第 ${index + 1} 条独立批注`,
          clientRequestId: randomUUID(),
        },
      );
    }
    await expectAppError(
      service.createComment(
        authorAssignment.assignmentId,
        authorUserId,
        {
          eventSequence: 2,
          content: "第六条批注应被拒绝",
          clientRequestId: randomUUID(),
        },
      ),
      "ECHO_COMMENT_LIMIT_REACHED",
    );
    assert.ok(retainedComment);

    await service.withdrawForReport(source.gameId);
    await expectAppError(
      service.listComments(authorAssignment.assignmentId, authorUserId),
      "ECHO_COMMENTS_LOCKED",
    );

    const secondSource = await createSourceGame(["human", "ai"]);
    await service.initializeArchiveCandidate({
      gameId: secondSource.gameId,
      durationMs: 20_000,
      eligible: true,
    });
    await service.submitConsent({
      gameId: secondSource.gameId,
      userId: secondSource.userIds[0]!,
      decision: "approve",
      clientRequestId: randomUUID(),
    });
    const secondAssignment = await service.createAssignment(authorUserId);
    await service.submitJudgment(
      secondAssignment.assignmentId,
      authorUserId,
      {
        guessA: "ai",
        confidenceA: 60,
        guessB: "human",
        confidenceB: 60,
        clientRequestId: randomUUID(),
      },
    );
    await expectAppError(
      service.setCommentLike(
        secondAssignment.assignmentId,
        authorUserId,
        retainedComment.id,
        true,
      ),
      "ECHO_COMMENT_UNAVAILABLE",
    );
  });

  it("七日保留任务删除原始时序但保留已物化匿名档案", async () => {
    const beforeTimeline = await database.select().from(gameTimelineEvents);
    const beforeArchiveEvents = await database
      .select()
      .from(echoArchiveEvents);
    assert.ok(beforeTimeline.length > 0);
    assert.ok(beforeArchiveEvents.length > 0);

    const result = await runRetentionJobs(
      database as unknown as AppDatabase,
      new Date(BASE_TIME + 8 * 24 * 60 * 60_000),
    );
    assert.ok(result.timelineEventsDeleted > 0);
    assert.equal(
      (await database.select().from(gameTimelineEvents)).length,
      0,
    );
    assert.equal(
      (await database.select().from(echoArchiveEvents)).length,
      beforeArchiveEvents.length,
    );
  });
});
