import { describe, expect, it } from "vitest";
import {
  accountSessionResponseSchema,
  accountStatusSchema,
  archiveConsentResponseSchema,
  clientEventSchema,
  echoAssignmentResponseSchema,
  echoCommentLikeResponseSchema,
  echoCommentsResponseSchema,
  echoRecordsResponseSchema,
  emailSchema,
  forgotPasswordRequestSchema,
  forgotPasswordResponseSchema,
  loginAccountRequestSchema,
  logoutRequestSchema,
  logoutResponseSchema,
  passwordSchema,
  profileInputSchema,
  registerAccountRequestSchema,
  registerAccountResponseSchema,
  resetPasswordRequestSchema,
  resetPasswordResponseSchema,
  serverEventSchema,
  submitFeedbackRequestSchema,
  submitFeedbackResponseSchema,
  submitArchiveConsentRequestSchema,
  submitEchoJudgmentRequestSchema,
  submitEchoJudgmentResponseSchema,
  submitEchoCommentRequestSchema,
  verifyEmailRequestSchema,
  verifyEmailResponseSchema,
} from "./schemas.js";

describe("共享协议", () => {
  it("接受合法聊天事件并拒绝超长内容", () => {
    expect(
      clientEventSchema.safeParse({
        type: "chat.send",
        content: "你好",
        clientMessageId: "message-001",
      }).success,
    ).toBe(true);
    expect(
      clientEventSchema.safeParse({
        type: "chat.send",
        content: "x".repeat(101),
        clientMessageId: "message-002",
      }).success,
    ).toBe(false);
  });

  it("校验玩家资料和结算消息", () => {
    expect(
      profileInputSchema.safeParse({
        nickname: "观察者",
        typingStatus: "正在想…",
      }).success,
    ).toBe(true);
    expect(
      serverEventSchema.safeParse({
        type: "game.finished",
        opponentType: "ai",
        guess: "ai",
        isCorrect: true,
        outcome: "won",
        archiveConsentEligible: true,
      }).success,
    ).toBe(true);
  });

  it("严格校验回声档案同意、回放与判断契约", () => {
    const requestId = "7febf16e-48ef-4ef4-8422-edb227b6b7fe";
    expect(
      submitArchiveConsentRequestSchema.safeParse({
        decision: "approve",
        clientRequestId: requestId,
      }).success,
    ).toBe(true);
    expect(
      archiveConsentResponseSchema.safeParse({
        accepted: true,
        message: "你的选择已经记录。",
      }).success,
    ).toBe(true);
    expect(
      echoAssignmentResponseSchema.safeParse({
        assignmentId: requestId,
        archiveId: "afc6af5b-98ac-4ca5-9438-2fad3e0443ca",
        status: "active",
        expiresInSeconds: 600,
        durationMs: 30_000,
        events: [
          {
            sequence: 1,
            type: "typing.start",
            actor: "A",
            offsetMs: 1_000,
          },
          {
            sequence: 2,
            type: "message.visible",
            actor: "A",
            offsetMs: 4_000,
            content: "你好",
            moderated: false,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      submitEchoJudgmentRequestSchema.safeParse({
        guessA: "human",
        confidenceA: 80,
        guessB: "ai",
        confidenceB: 90,
        clientRequestId: requestId,
      }).success,
    ).toBe(true);
    expect(
      submitEchoJudgmentResponseSchema.safeParse({
        completed: true,
        identities: { A: "human", B: "ai" },
        correct: { A: true, B: true },
        correctCount: 2,
        bothCorrect: true,
        scoreDelta: 10,
        confidenceCalibration: 85,
        stats: {
          reviewsPlayed: 1,
          identitiesCorrect: 2,
          perfectJudgments: 1,
          score: 10,
        },
      }).success,
    ).toBe(true);
  });

  it("严格校验回声批注的公开锚点、长度和匿名响应", () => {
    const commentId = "177e9b97-f8a9-42ea-9560-518f1f39ffcf";
    expect(
      submitEchoCommentRequestSchema.safeParse({
        eventSequence: 2,
        content: "  这句话很像真人的临场反应。  ",
        clientRequestId: "7febf16e-48ef-4ef4-8422-edb227b6b7fe",
      }).success,
    ).toBe(true);
    expect(
      submitEchoCommentRequestSchema.safeParse({
        eventSequence: 2,
        content: "只",
        clientRequestId: "7febf16e-48ef-4ef4-8422-edb227b6b7fe",
      }).success,
    ).toBe(false);
    expect(
      echoCommentsResponseSchema.safeParse({
        comments: [
          {
            id: commentId,
            eventSequence: 2,
            authorAlias: "鉴证官 7K2",
            content: "这句话很像真人的临场反应。",
            createdAt: "2026-07-25T02:00:00.000Z",
            likeCount: 3,
            likedByMe: true,
            mine: false,
          },
        ],
        countsByEventSequence: { "2": 1 },
      }).success,
    ).toBe(true);
    expect(
      echoCommentsResponseSchema.safeParse({
        comments: [],
        countsByEventSequence: {},
        reviewerUserId: "7febf16e-48ef-4ef4-8422-edb227b6b7fe",
      }).success,
    ).toBe(false);
    expect(
      echoCommentLikeResponseSchema.safeParse({
        commentId,
        liked: true,
        likeCount: 4,
      }).success,
    ).toBe(true);
  });

  it("严格校验回声鉴证战绩并拒绝内部关联字段", () => {
    const response = {
      stats: {
        reviewsPlayed: 3,
        identitiesCorrect: 4,
        perfectJudgments: 1,
        score: 18,
      },
      records: [
        {
          id: "177e9b97-f8a9-42ea-9560-518f1f39ffcf",
          submittedAt: "2026-07-25T02:00:00.000Z",
          identities: { A: "human", B: "ai" },
          guesses: { A: "human", B: "human" },
          confidence: { A: 82, B: 61 },
          correct: { A: true, B: false },
          correctCount: 1,
          bothCorrect: false,
          scoreDelta: 4,
          confidenceCalibration: 61,
          durationMs: 42_000,
          messageCount: 8,
        },
      ],
    };
    expect(echoRecordsResponseSchema.safeParse(response).success).toBe(true);
    expect(
      echoRecordsResponseSchema.safeParse({
        ...response,
        records: [
          {
            ...response.records[0],
            archiveId: "afc6af5b-98ac-4ca5-9438-2fad3e0443ca",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("区分容量排队、寻找对手和五秒入场事件", () => {
    expect(
      serverEventSchema.safeParse({
        type: "match.queued",
        position: 3,
        queuedAt: Date.now(),
      }).success,
    ).toBe(true);
    expect(
      serverEventSchema.safeParse({
        type: "match.searching",
        searchStartedAt: Date.now(),
      }).success,
    ).toBe(true);
    expect(
      serverEventSchema.safeParse({
        type: "match.admission",
        gateEndsAt: Date.now() + 5_000,
      }).success,
    ).toBe(true);
    expect(
      serverEventSchema.safeParse({
        type: "match.queued",
        gateEndsAt: Date.now() + 5_000,
      }).success,
    ).toBe(false);
  });

  it("严格校验邮箱、密码边界和账户六态", () => {
    expect(emailSchema.parse("  sender@example.com ")).toBe(
      "sender@example.com",
    );
    expect(emailSchema.safeParse("not-an-email").success).toBe(false);
    expect(passwordSchema.safeParse("x".repeat(11)).success).toBe(false);
    expect(passwordSchema.safeParse("x".repeat(12)).success).toBe(true);
    expect(passwordSchema.safeParse("x".repeat(128)).success).toBe(true);
    expect(passwordSchema.safeParse("x".repeat(129)).success).toBe(false);

    for (const status of [
      "PENDING_EMAIL",
      "ACTIVE",
      "LIMITED",
      "SUSPENDED",
      "BANNED",
      "DELETED",
    ]) {
      expect(accountStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(accountStatusSchema.safeParse("UNKNOWN").success).toBe(false);
  });

  it("校验注册、邮箱验证和登录请求", () => {
    expect(
      registerAccountRequestSchema.safeParse({
        email: "player@example.com",
        password: "correct horse battery",
      }).success,
    ).toBe(true);
    expect(
      registerAccountRequestSchema.safeParse({
        email: "player@example.com",
        password: "correct horse battery",
        rememberMe: true,
      }).success,
    ).toBe(false);
    expect(
      verifyEmailRequestSchema.safeParse({
        token: "verification-token-with-safe-length",
      }).success,
    ).toBe(true);
    expect(
      loginAccountRequestSchema.safeParse({
        email: "player@example.com",
        password: "correct horse battery",
      }).success,
    ).toBe(true);
  });

  it("校验注册和验证的固定公共响应", () => {
    expect(
      registerAccountResponseSchema.safeParse({
        accepted: true,
        message: "如果邮箱可用，我们会发送验证邮件。",
      }).success,
    ).toBe(true);
    expect(
      verifyEmailResponseSchema.safeParse({
        verified: true,
      }).success,
    ).toBe(true);
    expect(
      verifyEmailResponseSchema.safeParse({
        verified: true,
        userId: "7febf16e-48ef-4ef4-8422-edb227b6b7fe",
      }).success,
    ).toBe(false);
  });

  it("会话响应不接受长期会话令牌或额外账号字段", () => {
    const validResponse = {
      authenticated: true,
      user: {
        id: "7febf16e-48ef-4ef4-8422-edb227b6b7fe",
        email: "player@example.com",
        status: "ACTIVE",
      },
      csrfToken: "csrf-token-with-safe-length",
      sessionExpiresAt: Date.now() + 60_000,
      wsTicket: "single-use-websocket-ticket",
      wsTicketExpiresAt: Date.now() + 30_000,
    };
    expect(accountSessionResponseSchema.safeParse(validResponse).success).toBe(
      true,
    );
    expect(
      accountSessionResponseSchema.safeParse({
        ...validResponse,
        token: "forbidden-long-lived-session-token",
      }).success,
    ).toBe(false);
    expect(
      accountSessionResponseSchema.safeParse({
        ...validResponse,
        user: {
          ...validResponse.user,
          emailVerifiedAt: new Date().toISOString(),
        },
      }).success,
    ).toBe(false);
  });

  it("校验找回、重置和注销契约", () => {
    expect(
      forgotPasswordRequestSchema.safeParse({
        email: "player@example.com",
      }).success,
    ).toBe(true);
    expect(
      forgotPasswordResponseSchema.safeParse({
        accepted: true,
        message: "如果账号可用，我们会发送密码重置邮件。",
      }).success,
    ).toBe(true);
    expect(
      resetPasswordRequestSchema.safeParse({
        token: "password-reset-token-with-safe-length",
        newPassword: "another strong password",
      }).success,
    ).toBe(true);
    expect(
      resetPasswordResponseSchema.safeParse({
        reset: true,
      }).success,
    ).toBe(true);
    expect(logoutRequestSchema.safeParse({}).success).toBe(true);
    expect(logoutRequestSchema.safeParse({ all: true }).success).toBe(false);
    expect(logoutResponseSchema.safeParse({ loggedOut: true }).success).toBe(
      true,
    );
  });

  it("严格校验问题与意见反馈契约", () => {
    expect(
      submitFeedbackRequestSchema.safeParse({
        category: "bug",
        title: "移动端按钮被遮挡",
        details: "在小屏幕设备横屏时，提交判断按钮无法完整显示。",
      }).success,
    ).toBe(true);
    expect(
      submitFeedbackRequestSchema.safeParse({
        category: "feature",
        title: "错误分类",
        details: "分类必须来自协议允许的固定集合。",
      }).success,
    ).toBe(false);
    expect(
      submitFeedbackRequestSchema.safeParse({
        category: "other",
        title: "x",
        details: "x".repeat(2_001),
      }).success,
    ).toBe(false);
    expect(
      submitFeedbackResponseSchema.safeParse({
        accepted: true,
        feedbackId: "7febf16e-48ef-4ef4-8422-edb227b6b7fe",
        message: "感谢你的反馈喵～",
      }).success,
    ).toBe(true);
  });
});
