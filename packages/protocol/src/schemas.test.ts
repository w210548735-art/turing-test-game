import { describe, expect, it } from "vitest";
import {
  accountSessionResponseSchema,
  accountStatusSchema,
  clientEventSchema,
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
      }).success,
    ).toBe(true);
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
});
