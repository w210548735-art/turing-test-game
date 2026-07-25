import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  bootstrapAccountRequestSchema,
  clientEventSchema,
  forgotPasswordRequestSchema,
  loginAccountRequestSchema,
  logoutRequestSchema,
  profileInputSchema,
  registerAccountRequestSchema,
  resetPasswordRequestSchema,
  submitEchoCommentRequestSchema,
  submitArchiveConsentRequestSchema,
  submitEchoJudgmentRequestSchema,
  submitFeedbackRequestSchema,
  verifyEmailRequestSchema,
  type ClientEvent,
} from "@turing-game/protocol";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { sql } from "drizzle-orm";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { AppError, errorBody } from "./errors.js";
import { aiRuntimeController } from "./ai/runtime-controller.js";
import { AiUsageBudgetService } from "./ai/usage-budget.js";
import { resolveDeepSeekKey } from "./ai.js";
import {
  Argon2idPasswordHasher,
  AuthError,
  AuthService,
  canonicalizeEmail,
  DeviceService,
  InMemoryAuthRepository,
  loadQqSmtpConfig,
  QqSmtpEmailDelivery,
  SessionService,
  VerificationTokenService,
  type AuthRepository,
  type AuthUser,
  type EmailDelivery,
  type PasswordHasher,
  type SessionRecord,
} from "./auth/index.js";
import {
  AdminAuthenticator,
  AdminAuthError,
  principalsFromEnvironment,
} from "./admin/index.js";
import {
  createDatabase,
  BanRepository as DatabaseBanRepository,
  FeedbackRepository as DatabaseFeedbackRepository,
  GameRepository,
  PostgresAuthRepository,
  ReportRepository as DatabaseReportRepository,
  runRetentionJobs,
  type DatabaseState,
} from "./db/index.js";
import {
  FeedbackDigestWorker,
  FeedbackService,
  type FeedbackEmailDelivery,
  type FeedbackRepositoryPort,
} from "./feedback/index.js";
import { EchoArchiveService } from "./echo/index.js";
import {
  DEFAULT_MAX_CONCURRENT_ROOMS,
  DEFAULT_MAX_QUEUE_SIZE,
  GameService,
} from "./game.js";
import {
  buildSecurityHeaders,
  createSecurityCookiePolicy,
  OriginPolicy,
  parseCookieHeader,
  serializeDeviceCookie,
  serializeSessionCookie,
  SessionBoundCsrfService,
} from "./http-security/index.js";
import { AiBudgetController } from "./matchmaking/ai-budget.js";
import { ModerationPipeline } from "./moderation/index.js";
import {
  MemoryCompositeRateLimiter,
  type RateLimitOperation,
} from "./rate-limit/index.js";
import { SlidingWindowLimiter } from "./rate-limit.js";
import {
  createRedisRuntime,
  type RedisRuntime,
  WsTicketStore,
} from "./redis/index.js";
import {
  MemoryReportRepository,
  ReportService,
  type ReportReasonCode,
  type ReportStatus,
} from "./reports/index.js";
import {
  BanService,
  MemoryBanRepository,
  type BanReasonCode,
  type BanScope,
} from "./risk/index.js";
import { RoomSnapshotStore } from "./rooms/index.js";
import {
  validateNickname,
  validateTypingStatus,
} from "./security.js";
import type { Session, WsEnvelope } from "./types.js";

const DEFAULT_PROFILE = {
  nickname: "神秘访客",
  typingStatus: "正在组织语言…",
};
const SESSION_TTL_MS = 24 * 60 * 60_000;
const SESSION_IDLE_TTL_MS = 2 * 60 * 60_000;
const DEVICE_TTL_SECONDS = 365 * 24 * 60 * 60;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function getIp(request: FastifyRequest): string {
  return request.ip || request.socket.remoteAddress || "unknown";
}

function positiveIntegerEnvironment(
  name: string,
  fallback: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须配置为正整数。`);
  }
  return parsed;
}

export interface ServerContext {
  app: FastifyInstance;
  sessions: Map<string, Session>;
  games: GameService;
  wss: WebSocketServer;
  redis: RedisRuntime;
  database: DatabaseState;
  auth: {
    repository: AuthRepository;
    service: AuthService;
    sessions: SessionService;
    devices: DeviceService;
    registrationOpen: boolean;
    emailConfigured: boolean;
  };
  feedback: {
    configured: boolean;
    worker?: FeedbackDigestWorker;
  };
  echo: {
    configured: boolean;
    service?: EchoArchiveService;
  };
}

export interface ServerOptions {
  authRepository?: AuthRepository;
  emailDelivery?: EmailDelivery;
  passwordHasher?: PasswordHasher;
  registrationOpen?: boolean;
  feedbackRepository?: FeedbackRepositoryPort;
  feedbackDelivery?: FeedbackEmailDelivery;
  feedbackRecipientEmail?: string;
  feedbackDigest?: {
    now?: () => Date;
    leaseOwner?: string;
    leaseMs?: number;
    intervalMs?: number;
    autoStart?: boolean;
  };
}

export async function buildServer(
  options: ServerOptions = {},
): Promise<ServerContext> {
  const production = process.env.NODE_ENV === "production";
  const csrfSecret =
    process.env.CSRF_SECRET ??
    (production
      ? undefined
      : "local-development-csrf-secret-change-before-production");
  if (!csrfSecret) {
    throw new Error("生产环境必须配置 CSRF_SECRET");
  }
  const allowedOrigins = (
    process.env.ALLOWED_ORIGINS ??
    "http://127.0.0.1:5173,http://localhost:5173"
  )
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const cookiePolicy = createSecurityCookiePolicy(
    production ? "production" : "development",
  );
  const csrfService = new SessionBoundCsrfService(csrfSecret);
  const originPolicy = new OriginPolicy(allowedOrigins);
  const securityHeaders = buildSecurityHeaders({ production });
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.x-csrf-token",
        "headers.authorization",
        "headers.cookie",
        "headers.x-csrf-token",
        "token",
        "body.token",
        "body.password",
        "body.newPassword",
        "body.currentPassword",
        "req.body.token",
        "req.body.password",
        "req.body.newPassword",
        "req.body.currentPassword",
        "body.details",
        "body.title",
        "req.body.details",
        "req.body.title",
        "query.ticket",
        "req.query.ticket",
      ],
    },
    trustProxy: false,
    bodyLimit: 16 * 1024,
  });
  const sessions = new Map<string, Session>();
  const httpLimiter = new SlidingWindowLimiter();
  const wsLimiter = new SlidingWindowLimiter();
  const compositeLimiter = new MemoryCompositeRateLimiter({
    namespace: "demo-security",
  });
  const redis = await createRedisRuntime();
  const wsTickets = new WsTicketStore({ runtime: redis });
  const roomStore = new RoomSnapshotStore({ runtime: redis });
  const aiBudget = new AiBudgetController({ runtime: redis });
  const aiUsageBudget = new AiUsageBudgetService({
    namespace: "demo-ai-usage",
  });
  const database = createDatabase();
  const authRepository =
    options.authRepository ??
    (database.available
      ? new PostgresAuthRepository(database.db)
      : new InMemoryAuthRepository());
  const onlineGuestSetting =
    process.env.ALLOW_ONLINE_GUESTS?.trim().toLowerCase();
  const allowOnlineGuestSessions =
    onlineGuestSetting === undefined
      ? !production
      : onlineGuestSetting === "true";
  let qqEmailDelivery: QqSmtpEmailDelivery | undefined;
  let emailConfigured = Boolean(options.emailDelivery);
  let emailDelivery = options.emailDelivery;
  if (
    !emailDelivery &&
    process.env.QQ_SMTP_USER &&
    (process.env.QQ_SMTP_AUTH_CODE_FILE || process.env.QQ_SMTP_AUTH_CODE)
  ) {
    qqEmailDelivery = new QqSmtpEmailDelivery(await loadQqSmtpConfig());
    emailDelivery = qqEmailDelivery;
    emailConfigured = true;
  }
  const registrationSetting =
    process.env.REGISTRATION_OPEN?.trim().toLowerCase();
  const registrationOpen =
    options.registrationOpen ??
    (registrationSetting === undefined
      ? emailConfigured
      : registrationSetting === "true");
  emailDelivery ??= {
    async send() {
      throw new AppError(
        "EMAIL_DELIVERY_UNAVAILABLE",
        "邮件服务暂不可用，请稍后重试。",
        503,
      );
    },
  };
  const feedbackRepository =
    options.feedbackRepository ??
    (database.available
      ? new DatabaseFeedbackRepository(database.db)
      : undefined);
  const feedbackDelivery =
    options.feedbackDelivery ?? qqEmailDelivery;
  const feedbackRecipientValue =
    options.feedbackRecipientEmail ??
    process.env.FEEDBACK_RECIPIENT_EMAIL;
  const feedbackRecipientEmail = feedbackRecipientValue?.trim()
    ? canonicalizeEmail(feedbackRecipientValue)
    : undefined;
  const feedbackService =
    feedbackRepository
      ? new FeedbackService({
          repository: feedbackRepository,
        })
      : undefined;
  const feedbackDigestWorker =
    feedbackRepository && feedbackDelivery && feedbackRecipientEmail
      ? new FeedbackDigestWorker({
          repository: feedbackRepository,
          delivery: feedbackDelivery,
          recipientEmail: feedbackRecipientEmail,
          now: options.feedbackDigest?.now,
          leaseOwner: options.feedbackDigest?.leaseOwner,
          leaseMs: options.feedbackDigest?.leaseMs,
          intervalMs: options.feedbackDigest?.intervalMs,
          onFailure(digestId, errorName) {
            app.log.error(
              { digestId, errorName },
              "feedback digest email delivery failed",
            );
          },
        })
      : undefined;
  if (
    production &&
    registrationOpen &&
    (!database.available || !emailConfigured)
  ) {
    throw new Error(
      "生产环境开放注册必须同时配置 PostgreSQL 与 QQ SMTP 邮件投递。",
    );
  }
  const accountSessions = new SessionService(
    authRepository,
    undefined,
    undefined,
    csrfService,
  );
  const authService = new AuthService(
    authRepository,
    options.passwordHasher ?? new Argon2idPasswordHasher(),
    new VerificationTokenService(authRepository),
    accountSessions,
    emailDelivery,
    {
      onEmailDeliveryFailure(purpose) {
        app.log.error(
          { purpose },
          "account email delivery failed",
        );
      },
    },
  );
  const deviceService = new DeviceService(authRepository);
  const gameRepository = database.available
    ? new GameRepository(database.db)
    : undefined;
  const databaseReportRepository = database.available
    ? new DatabaseReportRepository(database.db)
    : undefined;
  const echoArchiveService = database.available
    ? new EchoArchiveService(database.db)
    : undefined;
  const databaseBanRepository = database.available
    ? new DatabaseBanRepository(database.db)
    : undefined;
  const safetyReportRepository = new MemoryReportRepository();
  const reportService = new ReportService(safetyReportRepository);
  const banService = new BanService(
    new MemoryBanRepository(),
    process.env.BAN_IDENTIFIER_PEPPER ??
      "local-development-ban-pepper-2026",
  );
  const adminAuthenticator = new AdminAuthenticator(
    principalsFromEnvironment(),
  );
  const moderation = new ModerationPipeline();
  const games = new GameService({
    aiBudget,
    aiUsageBudget,
    roomStore,
    gameRepository,
    reportRepository: databaseReportRepository,
    echoArchiveService,
    moderation,
    maxConcurrentRooms: positiveIntegerEnvironment(
      "MATCH_MAX_CONCURRENT_ROOMS",
      DEFAULT_MAX_CONCURRENT_ROOMS,
    ),
    maxQueueSize: positiveIntegerEnvironment(
      "MATCH_MAX_QUEUE_SIZE",
      DEFAULT_MAX_QUEUE_SIZE,
    ),
    onMetric(metric) {
      app.log.info(
        {
          recentGames: metric.recentGames,
          aiGames: metric.aiGames,
          aiRatio: metric.aiRatio,
          target: metric.target,
          aboveTarget: metric.aboveTarget,
        },
        "match mix metric",
      );
    },
    async onModerationDecision(decision, session, room) {
      if (decision.action === "BLOCK" || decision.action === "TERMINATE") {
        await banService.recordSignal({
          scope: "USER",
          identifier: session.userId,
          type:
            decision.action === "TERMINATE"
              ? "MODERATION_TERMINATE"
              : "MODERATION_BLOCK",
          weight: decision.action === "TERMINATE" ? 70 : 25,
          audit: {
            actorId: session.userId,
            ipHash: session.ipHash,
          },
        });
      }
      if (databaseReportRepository && decision.action !== "ALLOW") {
        await databaseReportRepository.recordModerationEvent({
          gameId: room.id,
          userId: session.databaseUserId,
          source: "chat",
          category: decision.categories[0] ?? "unknown",
          decision:
            decision.action === "REDACT"
              ? "replace"
              : decision.action.toLowerCase() as
                  | "allow"
                  | "replace"
                  | "block"
                  | "terminate",
          riskScore:
            decision.action === "TERMINATE"
              ? 100
              : decision.action === "BLOCK"
                ? 70
                : 30,
          contentHash: decision.audit.contentSha256,
          metadata: {
            matchedRules: decision.matches.map((match) => match.ruleId),
          },
        });
      }
    },
    onPersistenceError(error, operation) {
      app.log.error({ error, operation }, "persistence operation failed");
    },
  });
  let retentionTimer: NodeJS.Timeout | undefined;
  if (database.available) {
    const executeRetention = async () => {
      try {
        const result = await runRetentionJobs(database.db);
        app.log.info(result, "data retention job completed");
      } catch (error) {
        app.log.error({ error }, "data retention job failed");
      }
    };
    void executeRetention();
    retentionTimer = setInterval(
      () => void executeRetention(),
      24 * 60 * 60_000,
    );
    retentionTimer.unref();
  }

  function cookiesFromRequest(
    request: FastifyRequest,
  ): ReadonlyMap<string, string> {
    try {
      return parseCookieHeader(request.headers.cookie);
    } catch {
      throw new AppError("INVALID_COOKIE", "Cookie 请求头无效。", 400);
    }
  }

  function createAccountRuntimeSession(
    record: SessionRecord,
    user: AuthUser,
    request: FastifyRequest,
  ): Session {
    return {
      sessionId: record.id,
      tokenHash: record.tokenHash,
      userId: user.id,
      ipHash:
        record.ipRiskKey ??
        banService.hashSubject("IP", getIp(request)),
      deviceId: record.deviceId ?? `account:${user.id}`,
      csrfHash: record.csrfTokenHash,
      createdAt: record.createdAt.getTime(),
      lastSeenAt: record.lastSeenAt.getTime(),
      idleExpiresAt: record.idleExpiresAt.getTime(),
      expiresAt: record.absoluteExpiresAt.getTime(),
      databaseUserId: user.id,
      accountAuthenticated: true,
      profile: {
        nickname: user.nickname,
        typingStatus: user.typingStatus,
      },
    };
  }

  async function sessionFromRequest(
    request: FastifyRequest,
  ): Promise<Session | undefined> {
    const cookies = cookiesFromRequest(request);
    const rawToken = cookies.get(cookiePolicy.names.session);
    if (!rawToken) return undefined;
    const tokenHash = sha256(rawToken);
    let session = sessions.get(tokenHash);
    if (!session) {
      try {
        const accountRecord =
          await authService.authenticateSession(rawToken);
        const user = await authService.getUser(accountRecord.userId);
        session = createAccountRuntimeSession(accountRecord, user, request);
        sessions.set(tokenHash, session);
      } catch (error) {
        if (error instanceof AuthError) return undefined;
        throw error;
      }
    } else if (session.accountAuthenticated) {
      try {
        const accountRecord =
          await authService.authenticateSession(rawToken);
        session.lastSeenAt = accountRecord.lastSeenAt.getTime();
        session.idleExpiresAt = accountRecord.idleExpiresAt.getTime();
      } catch (error) {
        if (error instanceof AuthError) {
          sessions.delete(tokenHash);
          session.socket?.close(4003, "Session revoked");
          return undefined;
        }
        throw error;
      }
    }
    const now = Date.now();
    if (
      session.expiresAt <= now ||
      session.idleExpiresAt <= now
    ) {
      sessions.delete(tokenHash);
      session.socket?.close(4003, "Session expired");
      return undefined;
    }
    if (!session.accountAuthenticated) {
      session.lastSeenAt = now;
      session.idleExpiresAt = Math.min(
        now + SESSION_IDLE_TTL_MS,
        session.expiresAt,
      );
    }
    return session;
  }

  async function touchWebSocketSession(session: Session): Promise<void> {
    const now = Date.now();
    if (session.expiresAt <= now || session.idleExpiresAt <= now) {
      sessions.delete(session.tokenHash);
      session.socket?.close(4003, "Session expired");
      throw new AppError(
        "SESSION_EXPIRED",
        "会话无效或已过期。",
        401,
      );
    }
    if (!session.accountAuthenticated) {
      session.lastSeenAt = now;
      session.idleExpiresAt = Math.min(
        now + SESSION_IDLE_TTL_MS,
        session.expiresAt,
      );
      return;
    }

    const record = await authRepository.findSessionByHash(
      session.tokenHash,
    );
    if (
      !record ||
      record.revokedAt ||
      record.absoluteExpiresAt.getTime() <= now ||
      record.idleExpiresAt.getTime() <= now
    ) {
      sessions.delete(session.tokenHash);
      session.socket?.close(4003, "Session revoked");
      throw new AppError(
        "SESSION_REVOKED",
        "会话无效或已过期。",
        401,
      );
    }
    try {
      await authService.assertAccountCapability(session.userId, "ACCOUNT");
    } catch (error) {
      if (error instanceof AuthError) {
        sessions.delete(session.tokenHash);
        session.socket?.close(4003, "Account restricted");
        throw new AppError(error.code, error.message, 403);
      }
      throw error;
    }
    record.lastSeenAt = new Date(now);
    record.idleExpiresAt = new Date(
      Math.min(
        now + SESSION_IDLE_TTL_MS,
        record.absoluteExpiresAt.getTime(),
      ),
    );
    await authRepository.updateSession(record);
    session.lastSeenAt = now;
    session.idleExpiresAt = record.idleExpiresAt.getTime();
  }

  function requireCsrf(
    request: FastifyRequest,
    session: Session,
  ): void {
    const header = request.headers["x-csrf-token"];
    const presented = typeof header === "string" ? header : undefined;
    if (!csrfService.verify(session.sessionId, presented, session.csrfHash)) {
      throw new AppError("CSRF_INVALID", "CSRF 校验失败。", 403);
    }
  }

  async function consumeGameRateLimit(
    operation: RateLimitOperation,
    session: Session,
    roomId = session.roomId,
  ): Promise<void> {
    const decision = await compositeLimiter.consume({
      operation,
      identity: {
        ip: session.ipHash,
        deviceId: session.deviceId,
        sessionId: session.sessionId,
        userId: session.userId,
        roomId,
      },
    });
    if (!decision.allowed) {
      throw new AppError(
        "RATE_LIMITED",
        `操作过于频繁，请在 ${Math.ceil(decision.retryAfterMs / 1_000)} 秒后重试。`,
        429,
      );
    }
  }

  async function consumePublicAuthRateLimit(
    operation: RateLimitOperation,
    request: FastifyRequest,
    email?: string,
  ): Promise<void> {
    const cookies = cookiesFromRequest(request);
    const deviceToken = cookies.get(cookiePolicy.names.device);
    const emailHash = email ? sha256(canonicalizeEmail(email)) : undefined;
    const decision = await compositeLimiter.consume({
      operation,
      identity: {
        ip: banService.hashSubject("IP", getIp(request)),
        ...(deviceToken ? { deviceId: sha256(deviceToken) } : {}),
        ...(emailHash
          ? {
              emailHash,
              // 登录策略在认证前也需要稳定的用户维度，使用规范化邮箱摘要。
              userId: emailHash,
            }
          : {}),
      },
    });
    if (!decision.allowed) {
      throw new AppError(
        "RATE_LIMITED",
        `操作过于频繁，请在 ${Math.ceil(decision.retryAfterMs / 1_000)} 秒后重试。`,
        429,
      );
    }
  }

  async function resolveAccountDevice(
    request: FastifyRequest,
  ): Promise<{
    token: string;
    device: Awaited<ReturnType<DeviceService["recognize"]>>;
  }> {
    const cookies = cookiesFromRequest(request);
    const candidate = cookies.get(cookiePolicy.names.device);
    if (candidate) {
      try {
        return {
          token: candidate,
          device: await deviceService.recognize(candidate),
        };
      } catch (error) {
        if (!(error instanceof AuthError) || error.code !== "DEVICE_INVALID") {
          throw error;
        }
      }
    }
    return deviceService.issue();
  }

  async function accountSessionResponse(
    request: FastifyRequest,
    reply: FastifyReply,
    issued: Awaited<ReturnType<AuthService["rotateSession"]>>,
    deviceToken: string,
  ) {
    const user = await authService.getUser(issued.session.userId);
    const runtimeSession = createAccountRuntimeSession(
      issued.session,
      user,
      request,
    );
    sessions.set(runtimeSession.tokenHash, runtimeSession);
    const wsTicket =
      user.status === "ACTIVE"
        ? await wsTickets.issue({
            userId: runtimeSession.userId,
            sessionId: runtimeSession.tokenHash,
          })
        : undefined;
    reply.header("set-cookie", [
      serializeSessionCookie(issued.token, cookiePolicy, {
        maxAgeSeconds: Math.max(
          0,
          Math.floor(
            (issued.session.absoluteExpiresAt.getTime() - Date.now()) / 1_000,
          ),
        ),
        expires: issued.session.absoluteExpiresAt,
      }),
      serializeDeviceCookie(deviceToken, cookiePolicy, {
        maxAgeSeconds: DEVICE_TTL_SECONDS,
      }),
    ]);
    return {
      authenticated: true as const,
      user: {
        id: user.id,
        email: user.emailOriginal,
        status: user.status,
      },
      csrfToken: issued.csrfToken,
      sessionExpiresAt: issued.session.absoluteExpiresAt.getTime(),
      ...(wsTicket
        ? {
            wsTicket: wsTicket.ticket,
            wsTicketExpiresAt: wsTicket.expiresAt,
          }
        : {}),
    };
  }

  async function isBlocked(
    scope: BanScope,
    identifier: string,
  ): Promise<boolean> {
    const memoryAssessment = await banService.assess(scope, identifier);
    if (memoryAssessment.disposition === "BLOCK") return true;
    if (!databaseBanRepository) return false;
    const persistent = await databaseBanRepository.findActive(
      scope.toLowerCase() as "user" | "session" | "device" | "ip",
      banService.hashSubject(scope, identifier),
    );
    return persistent !== null;
  }

  function requireAdmin(
    request: FastifyRequest,
    permission:
      | "REPORT_READ"
      | "REPORT_DECIDE"
      | "BAN_ISSUE"
      | "BAN_REVOKE"
      | "AUDIT_READ",
  ) {
    try {
      const authentication = adminAuthenticator.authenticate(
        request.headers.authorization,
        request.id,
      );
      adminAuthenticator.require(authentication, permission);
      return authentication;
    } catch (error) {
      if (error instanceof AdminAuthError) {
        throw new AppError(
          error.code,
          error.message,
          error.code === "FORBIDDEN" ? 403 : 401,
        );
      }
      throw error;
    }
  }

  app.addHook("onRequest", async (request, reply) => {
    for (const [name, value] of Object.entries(securityHeaders)) {
      reply.header(name, value);
    }
    reply.header("cache-control", "no-store");
    const origin =
      typeof request.headers.origin === "string"
        ? request.headers.origin
        : undefined;
    const path = request.url.split("?", 1)[0] ?? "";
    const requiresBrowserOrigin =
      path.startsWith("/api/auth/") ||
      path === "/api/session" ||
      path === "/api/profile" ||
      path === "/api/ws-ticket" ||
      path === "/api/session/logout" ||
      path === "/api/feedback" ||
      path.startsWith("/api/games/") ||
      path.startsWith("/api/echo/");
    const decision = originPolicy.evaluateHttp(request.method, origin);
    if (
      !decision.allowed &&
      (origin !== undefined || requiresBrowserOrigin)
    ) {
      throw new AppError("ORIGIN_FORBIDDEN", "不允许的请求来源。", 403);
    }
    if (origin) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
      reply.header("access-control-allow-credentials", "true");
      reply.header(
        "access-control-allow-headers",
        "Authorization, Content-Type, X-CSRF-Token",
      );
      reply.header(
        "access-control-allow-methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      );
      reply.header("access-control-max-age", "600");
    }
    if (request.method === "OPTIONS") {
      await reply.status(204).send();
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const normalizedError =
      error instanceof AuthError
        ? new AppError(
            error.code,
            error.message,
            error.code === "INVALID_CREDENTIALS" ||
              error.code === "SESSION_INVALID" ||
              error.code === "SESSION_EXPIRED" ||
              error.code === "SESSION_REVOKED"
              ? 401
              : error.code === "ACCOUNT_RESTRICTED"
                ? 403
                : error.code === "SESSION_NOT_FOUND"
                  ? 404
                  : error.code === "TOKEN_EXPIRED"
                    ? 410
                    : 400,
          )
        : error;
    const statusCode =
      normalizedError instanceof AppError
        ? normalizedError.statusCode
        : normalizedError &&
            typeof normalizedError === "object" &&
            "statusCode" in normalizedError &&
            typeof normalizedError.statusCode === "number"
          ? normalizedError.statusCode
          : 500;
    if (!(normalizedError instanceof AppError)) {
      app.log.error(normalizedError, "request failed");
    }
    reply.status(statusCode).send(errorBody(normalizedError));
  });

  app.get("/api/health", async () => {
    const [redisHealth, aiKey] = await Promise.all([
      redis.health(),
      resolveDeepSeekKey(),
    ]);
    return {
      ok: redisHealth.ok,
      service: "turing-game-server",
      now: new Date().toISOString(),
      matchMix: games.getMetrics(),
      ai: aiRuntimeController.snapshot(),
      aiProvider: { configured: Boolean(aiKey) },
      redis: redisHealth,
      database: {
        configured: database.available,
        mode: database.available ? "postgresql" : "memory-demo",
      },
      account: {
        registrationOpen,
        emailConfigured,
        persistence: database.available ? "postgresql" : "memory-demo",
      },
      feedback: {
        configured: Boolean(feedbackDigestWorker),
        persistence: feedbackRepository ? "available" : "unavailable",
      },
    };
  });

  app.get("/api/ready", async (_request, reply) => {
    const [redisHealth, aiKey, databaseOk] = await Promise.all([
      redis.health(),
      resolveDeepSeekKey(),
      database.available
        ? database.db
            .execute(sql`select 1 as ok`)
            .then(() => true)
            .catch(() => false)
        : Promise.resolve(false),
    ]);
    const ready =
      redis.mode === "redis" &&
      redisHealth.ok &&
      databaseOk &&
      Boolean(aiKey) &&
      (!registrationOpen || emailConfigured);
    if (!ready) {
      reply.status(503);
    }
    return {
      ready,
      redis: {
        configured: redis.mode === "redis",
        ok: redisHealth.ok,
      },
      database: {
        configured: database.available,
        ok: databaseOk,
      },
      aiProvider: { configured: Boolean(aiKey) },
      account: {
        registrationOpen,
        emailConfigured,
        ready: !registrationOpen || (databaseOk && emailConfigured),
      },
      feedback: {
        configured: Boolean(feedbackDigestWorker),
      },
    };
  });

  app.post<{ Body: unknown }>(
    "/api/auth/register",
    async (request, reply) => {
      if (!registrationOpen) {
        throw new AppError(
          "REGISTRATION_CLOSED",
          "当前暂未开放注册。",
          403,
        );
      }
      const parsed = registerAccountRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(
          "INVALID_REGISTRATION",
          "请提供有效邮箱和 12–128 位密码。",
        );
      }
      await consumePublicAuthRateLimit(
        "auth.register",
        request,
        parsed.data.email,
      );
      await consumePublicAuthRateLimit(
        "email.verification.send",
        request,
        parsed.data.email,
      );
      const result = await authService.register(
        parsed.data.email,
        parsed.data.password,
      );
      reply.status(202);
      return result;
    },
  );

  app.put<{
    Params: { gameId: string };
    Body: unknown;
  }>(
    "/api/games/:gameId/archive-consent",
    async (request) => {
      const session = await sessionFromRequest(request);
      if (!session?.accountAuthenticated) {
        throw new AppError(
          "ACCOUNT_REQUIRED",
          "请先登录已验证的账号，再决定是否保存对话。",
          401,
        );
      }
      requireCsrf(request, session);
      await authService.assertAccountCapability(session.userId, "ACCOUNT");
      if (!echoArchiveService || !UUID_PATTERN.test(request.params.gameId)) {
        throw new AppError(
          "ARCHIVE_CONSENT_UNAVAILABLE",
          "这局对话暂时无法保存，请继续体验其他对局。",
          409,
        );
      }
      const parsed = submitArchiveConsentRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(
          "INVALID_ARCHIVE_CONSENT",
          "保存选择格式无效。",
          400,
        );
      }
      await consumeGameRateLimit("echo.consent", session);
      await echoArchiveService.submitConsent({
        gameId: request.params.gameId,
        userId: session.databaseUserId ?? session.userId,
        decision: parsed.data.decision,
        clientRequestId: parsed.data.clientRequestId,
      });
      return {
        accepted: true as const,
        message: "你的选择已经悄悄记下啦 ฅ( ̳• ·̫ • ̳ฅ)",
      };
    },
  );

  app.post("/api/echo/assignments", async (request) => {
    const session = await sessionFromRequest(request);
    if (!session?.accountAuthenticated) {
      throw new AppError(
        "ACCOUNT_REQUIRED",
        "请先登录已验证的账号，再成为回声鉴证官。",
        401,
      );
    }
    requireCsrf(request, session);
    await authService.assertAccountCapability(session.userId, "MATCH");
    if (!echoArchiveService) {
      throw new AppError(
        "ECHO_ARCHIVE_UNAVAILABLE",
        "暂时没有新的回声档案，请稍后再来看看。",
        404,
      );
    }
    await consumeGameRateLimit("echo.assignment", session);
    return echoArchiveService.createAssignment(
      session.databaseUserId ?? session.userId,
    );
  });

  app.get<{
    Params: { assignmentId: string };
  }>(
    "/api/echo/assignments/:assignmentId",
    async (request) => {
      const session = await sessionFromRequest(request);
      if (!session?.accountAuthenticated) {
        throw new AppError(
          "ACCOUNT_REQUIRED",
          "请先登录已验证的账号，再继续查看档案。",
          401,
        );
      }
      await authService.assertAccountCapability(session.userId, "MATCH");
      if (
        !echoArchiveService ||
        !UUID_PATTERN.test(request.params.assignmentId)
      ) {
        throw new AppError(
          "ECHO_ASSIGNMENT_UNAVAILABLE",
          "这份档案已经过期或不可用，请领取新的档案。",
          409,
        );
      }
      await consumeGameRateLimit("echo.assignment", session);
      return echoArchiveService.getAssignment(
        request.params.assignmentId,
        session.databaseUserId ?? session.userId,
      );
    },
  );

  app.post<{
    Params: { assignmentId: string };
    Body: unknown;
  }>(
    "/api/echo/assignments/:assignmentId/judgment",
    async (request) => {
      const session = await sessionFromRequest(request);
      if (!session?.accountAuthenticated) {
        throw new AppError(
          "ACCOUNT_REQUIRED",
          "请先登录已验证的账号，再提交身份判读。",
          401,
        );
      }
      requireCsrf(request, session);
      await authService.assertAccountCapability(session.userId, "MATCH");
      if (
        !echoArchiveService ||
        !UUID_PATTERN.test(request.params.assignmentId)
      ) {
        throw new AppError(
          "ECHO_ASSIGNMENT_UNAVAILABLE",
          "这份档案已经结束或不可用，请领取新的档案。",
          409,
        );
      }
      const parsed = submitEchoJudgmentRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(
          "INVALID_ECHO_JUDGMENT",
          "请分别判断匿名玩家 A、B 的身份并填写置信度。",
          400,
        );
      }
      await consumeGameRateLimit("echo.judgment", session);
      return echoArchiveService.submitJudgment(
        request.params.assignmentId,
        session.databaseUserId ?? session.userId,
        parsed.data,
      );
    },
  );

  app.get("/api/echo/records", async (request) => {
    const session = await sessionFromRequest(request);
    if (!session?.accountAuthenticated) {
      throw new AppError(
        "ACCOUNT_REQUIRED",
        "请先登录已验证的账号，再查看回声鉴证战绩。",
        401,
      );
    }
    await authService.assertAccountCapability(session.userId, "MATCH");
    if (!echoArchiveService) {
      throw new AppError(
        "ECHO_RECORDS_UNAVAILABLE",
        "回声战绩暂时没有成功抵达，请稍后重试。",
        503,
      );
    }
    await consumeGameRateLimit("echo.record.read", session);
    return echoArchiveService.getReviewerRecords(
      session.databaseUserId ?? session.userId,
    );
  });

  app.get<{
    Params: { assignmentId: string };
  }>(
    "/api/echo/assignments/:assignmentId/comments",
    async (request) => {
      const session = await sessionFromRequest(request);
      if (!session?.accountAuthenticated) {
        throw new AppError(
          "ACCOUNT_REQUIRED",
          "请先登录已验证的账号，再查看回声批注。",
          401,
        );
      }
      await authService.assertAccountCapability(session.userId, "MATCH");
      if (
        !echoArchiveService ||
        !UUID_PATTERN.test(request.params.assignmentId)
      ) {
        throw new AppError(
          "ECHO_COMMENTS_LOCKED",
          "完成身份判断后，才可以查看和参与回声批注。",
          403,
        );
      }
      await consumeGameRateLimit("echo.comment.read", session);
      return echoArchiveService.listComments(
        request.params.assignmentId,
        session.databaseUserId ?? session.userId,
      );
    },
  );

  app.post<{
    Params: { assignmentId: string };
    Body: unknown;
  }>(
    "/api/echo/assignments/:assignmentId/comments",
    async (request) => {
      const session = await sessionFromRequest(request);
      if (!session?.accountAuthenticated) {
        throw new AppError(
          "ACCOUNT_REQUIRED",
          "请先登录已验证的账号，再留下回声批注。",
          401,
        );
      }
      requireCsrf(request, session);
      await authService.assertAccountCapability(session.userId, "MATCH");
      if (
        !echoArchiveService ||
        !UUID_PATTERN.test(request.params.assignmentId)
      ) {
        throw new AppError(
          "ECHO_COMMENTS_LOCKED",
          "完成身份判断后，才可以查看和参与回声批注。",
          403,
        );
      }
      const parsed = submitEchoCommentRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(
          "INVALID_ECHO_COMMENT",
          "请选择一条消息并填写 2–200 字的批注。",
          400,
        );
      }
      await consumeGameRateLimit(
        "echo.comment.write",
        session,
        request.params.assignmentId,
      );
      return echoArchiveService.createComment(
        request.params.assignmentId,
        session.databaseUserId ?? session.userId,
        parsed.data,
      );
    },
  );

  app.put<{
    Params: { assignmentId: string; commentId: string };
  }>(
    "/api/echo/assignments/:assignmentId/comments/:commentId/like",
    async (request) => {
      const session = await sessionFromRequest(request);
      if (!session?.accountAuthenticated) {
        throw new AppError(
          "ACCOUNT_REQUIRED",
          "请先登录已验证的账号，再为批注点赞。",
          401,
        );
      }
      requireCsrf(request, session);
      await authService.assertAccountCapability(session.userId, "MATCH");
      if (
        !echoArchiveService ||
        !UUID_PATTERN.test(request.params.assignmentId) ||
        !UUID_PATTERN.test(request.params.commentId)
      ) {
        throw new AppError(
          "ECHO_COMMENT_UNAVAILABLE",
          "这条批注不存在或已经被删除。",
          404,
        );
      }
      await consumeGameRateLimit("echo.comment.like", session);
      return echoArchiveService.setCommentLike(
        request.params.assignmentId,
        session.databaseUserId ?? session.userId,
        request.params.commentId,
        true,
      );
    },
  );

  app.delete<{
    Params: { assignmentId: string; commentId: string };
  }>(
    "/api/echo/assignments/:assignmentId/comments/:commentId/like",
    async (request) => {
      const session = await sessionFromRequest(request);
      if (!session?.accountAuthenticated) {
        throw new AppError(
          "ACCOUNT_REQUIRED",
          "请先登录已验证的账号，再管理批注点赞。",
          401,
        );
      }
      requireCsrf(request, session);
      await authService.assertAccountCapability(session.userId, "MATCH");
      if (
        !echoArchiveService ||
        !UUID_PATTERN.test(request.params.assignmentId) ||
        !UUID_PATTERN.test(request.params.commentId)
      ) {
        throw new AppError(
          "ECHO_COMMENT_UNAVAILABLE",
          "这条批注不存在或已经被删除。",
          404,
        );
      }
      await consumeGameRateLimit("echo.comment.like", session);
      return echoArchiveService.setCommentLike(
        request.params.assignmentId,
        session.databaseUserId ?? session.userId,
        request.params.commentId,
        false,
      );
    },
  );

  app.delete<{
    Params: { assignmentId: string; commentId: string };
  }>(
    "/api/echo/assignments/:assignmentId/comments/:commentId",
    async (request) => {
      const session = await sessionFromRequest(request);
      if (!session?.accountAuthenticated) {
        throw new AppError(
          "ACCOUNT_REQUIRED",
          "请先登录已验证的账号，再删除批注。",
          401,
        );
      }
      requireCsrf(request, session);
      await authService.assertAccountCapability(session.userId, "MATCH");
      if (
        !echoArchiveService ||
        !UUID_PATTERN.test(request.params.assignmentId) ||
        !UUID_PATTERN.test(request.params.commentId)
      ) {
        throw new AppError(
          "ECHO_COMMENT_DELETE_FORBIDDEN",
          "只能删除自己在这份档案中留下的批注。",
          403,
        );
      }
      await consumeGameRateLimit(
        "echo.comment.write",
        session,
        request.params.assignmentId,
      );
      return echoArchiveService.deleteComment(
        request.params.assignmentId,
        session.databaseUserId ?? session.userId,
        request.params.commentId,
      );
    },
  );

  app.post<{ Body: unknown }>(
    "/api/auth/verify-email",
    async (request) => {
      const parsed = verifyEmailRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError("TOKEN_INVALID", "验证链接无效。");
      }
      await consumePublicAuthRateLimit(
        "email.verification.consume",
        request,
      );
      await authService.verifyEmail(parsed.data.token);
      return { verified: true as const };
    },
  );

  app.post<{ Body: unknown }>(
    "/api/auth/login",
    async (request, reply) => {
      const parsed = loginAccountRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(
          "INVALID_CREDENTIALS",
          "邮箱、密码或账号状态无效。",
          401,
        );
      }
      await consumePublicAuthRateLimit(
        "auth.login",
        request,
        parsed.data.email,
      );
      const device = await resolveAccountDevice(request);
      const previousToken = cookiesFromRequest(request).get(
        cookiePolicy.names.session,
      );
      if (previousToken) {
        const previousHash = sha256(previousToken);
        const previous = sessions.get(previousHash);
        previous?.socket?.close(4002, "Session rotated");
        sessions.delete(previousHash);
        try {
          await authService.revokeCurrentSession(previousToken);
        } catch (error) {
          if (!(error instanceof AuthError)) throw error;
        }
      }
      const userAgent = request.headers["user-agent"] ?? "unknown";
      const issued = await authService.login(
        parsed.data.email,
        parsed.data.password,
        {
          deviceId: device.device.id,
          ipRiskKey: banService.hashSubject("IP", getIp(request)),
          userAgentSummary: sha256(userAgent),
        },
      );
      await deviceService.recognize(device.token, issued.session.userId);
      return accountSessionResponse(
        request,
        reply,
        issued,
        device.token,
      );
    },
  );

  app.post<{ Body: unknown }>(
    "/api/auth/bootstrap",
    async (request, reply) => {
      const parsed = bootstrapAccountRequestSchema.safeParse(
        request.body ?? {},
      );
      if (!parsed.success) {
        throw new AppError("INVALID_REQUEST", "请求格式无效。");
      }
      const cookies = cookiesFromRequest(request);
      const rawToken = cookies.get(cookiePolicy.names.session);
      if (!rawToken) {
        throw new AppError(
          "UNAUTHORIZED",
          "会话无效或已过期。",
          401,
        );
      }
      const device = await resolveAccountDevice(request);
      const oldHash = sha256(rawToken);
      const oldRuntime = sessions.get(oldHash);
      const issued = await authService.rotateSession(rawToken);
      oldRuntime?.socket?.close(4002, "Session rotated");
      sessions.delete(oldHash);
      await deviceService.recognize(device.token, issued.session.userId);
      if (issued.session.deviceId !== device.device.id) {
        issued.session.deviceId = device.device.id;
        await authRepository.updateSession(issued.session);
      }
      return accountSessionResponse(
        request,
        reply,
        issued,
        device.token,
      );
    },
  );

  app.post<{ Body: unknown }>(
    "/api/auth/password/forgot",
    async (request, reply) => {
      const parsed = forgotPasswordRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError("INVALID_EMAIL", "邮箱格式无效。");
      }
      await consumePublicAuthRateLimit(
        "email.password_reset.send",
        request,
        parsed.data.email,
      );
      const result = await authService.forgotPassword(parsed.data.email);
      reply.status(202);
      return result;
    },
  );

  app.post<{ Body: unknown }>(
    "/api/auth/password/reset",
    async (request) => {
      const parsed = resetPasswordRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(
          "INVALID_PASSWORD_RESET",
          "重置链接或新密码无效。",
        );
      }
      await consumePublicAuthRateLimit(
        "email.password_reset.consume",
        request,
      );
      const resetUser = await authService.resetPassword(
        parsed.data.token,
        parsed.data.newPassword,
      );
      for (const [tokenHash, runtimeSession] of sessions) {
        if (runtimeSession.userId !== resetUser.id) continue;
        runtimeSession.socket?.close(4003, "Session revoked");
        sessions.delete(tokenHash);
      }
      return { reset: true as const };
    },
  );

  app.post<{ Body: unknown }>(
    "/api/auth/logout",
    async (request, reply) => {
      const parsed = logoutRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new AppError("INVALID_REQUEST", "请求格式无效。");
      }
      const session = await sessionFromRequest(request);
      if (!session?.accountAuthenticated) {
        throw new AppError(
          "UNAUTHORIZED",
          "会话无效或已过期。",
          401,
        );
      }
      requireCsrf(request, session);
      const rawToken = cookiesFromRequest(request).get(
        cookiePolicy.names.session,
      );
      if (rawToken) {
        await authService.revokeCurrentSession(rawToken);
      }
      sessions.delete(session.tokenHash);
      session.socket?.close(4003, "Session revoked");
      reply.header(
        "set-cookie",
        serializeSessionCookie("", cookiePolicy, {
          maxAgeSeconds: 0,
          expires: new Date(0),
        }),
      );
      return { loggedOut: true as const };
    },
  );

  app.post<{ Body: unknown }>(
    "/api/feedback",
    async (request, reply) => {
      const session = await sessionFromRequest(request);
      if (!session?.accountAuthenticated) {
        throw new AppError(
          "ACCOUNT_REQUIRED",
          "请先登录已验证的账号，再提交反馈。",
          401,
        );
      }
      requireCsrf(request, session);
      await authService.assertAccountCapability(session.userId, "ACCOUNT");
      if (!feedbackService) {
        throw new AppError(
          "FEEDBACK_UNAVAILABLE",
          "反馈通道暂时开小差了，请稍后再试喵。",
          503,
        );
      }
      const parsed = submitFeedbackRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(
          "INVALID_FEEDBACK",
          "请选择反馈分类；标题需要 2–80 字，详细内容需要 10–2000 字。",
        );
      }
      await consumeGameRateLimit("feedback.submit", session);
      const result = await feedbackService.submit({
        userId: session.userId,
        category: parsed.data.category,
        title: parsed.data.title.normalize("NFKC"),
        details: parsed.data.details.normalize("NFKC"),
      });
      reply.status(202);
      return {
        accepted: true as const,
        feedbackId: result.feedbackId,
        message: "感谢你的反馈喵，作者正在加急修改 ing～",
      };
    },
  );

  app.post("/api/session", async (request, reply) => {
    if (!allowOnlineGuestSessions) {
      throw new AppError(
        "ACCOUNT_REQUIRED",
        "线上游戏需要先登录账号。",
        403,
      );
    }
    const ip = getIp(request);
    httpLimiter.take(`session:${ip}`, 10, 60_000);
    if (await isBlocked("IP", ip)) {
      throw new AppError("ACCESS_BLOCKED", "当前网络暂时无法创建会话。", 403);
    }
    let incomingCookies: ReadonlyMap<string, string>;
    try {
      incomingCookies = parseCookieHeader(request.headers.cookie);
    } catch {
      throw new AppError("INVALID_COOKIE", "Cookie 请求头无效。", 400);
    }
    const previousToken = incomingCookies.get(cookiePolicy.names.session);
    if (previousToken) {
      const previous = sessions.get(sha256(previousToken));
      previous?.socket?.close(4002, "Session rotated");
      sessions.delete(sha256(previousToken));
    }
    const rawSessionToken = randomBytes(32).toString("base64url");
    const tokenHash = sha256(rawSessionToken);
    const candidateDeviceToken = incomingCookies.get(
      cookiePolicy.names.device,
    );
    const rawDeviceToken =
      candidateDeviceToken &&
      /^[A-Za-z0-9_-]{32,128}$/u.test(candidateDeviceToken)
        ? candidateDeviceToken
        : randomBytes(32).toString("base64url");
    const now = Date.now();
    const sessionId = randomUUID();
    const csrf = csrfService.issue(sessionId, new Date(now));
    const session: Session = {
      sessionId,
      tokenHash,
      userId: randomUUID(),
      ipHash: banService.hashSubject("IP", ip),
      deviceId: sha256(rawDeviceToken),
      csrfHash: csrf.hash,
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: now + SESSION_IDLE_TTL_MS,
      expiresAt: now + SESSION_TTL_MS,
      profile: { ...DEFAULT_PROFILE },
    };
    if (gameRepository) {
      const databaseUser = await gameRepository.upsertGuest({
        sessionTokenHash: tokenHash,
        nickname: session.profile.nickname,
        typingStatus: session.profile.typingStatus,
      });
      session.databaseUserId = databaseUser.id;
    }
    sessions.set(tokenHash, session);
    const wsTicket = await wsTickets.issue({
      userId: session.userId,
      sessionId: tokenHash,
    });
    reply
      .header("set-cookie", [
        serializeSessionCookie(rawSessionToken, cookiePolicy, {
          maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1_000),
          expires: new Date(session.expiresAt),
        }),
        serializeDeviceCookie(rawDeviceToken, cookiePolicy, {
          maxAgeSeconds: DEVICE_TTL_SECONDS,
        }),
      ])
      .status(201);
    return {
      userId: session.userId,
      csrfToken: csrf.token,
      wsTicket: wsTicket.ticket,
      wsTicketExpiresAt: wsTicket.expiresAt,
      sessionExpiresAt: session.expiresAt,
    };
  });

  app.put<{ Body: unknown }>("/api/profile", async (request) => {
    const session = await sessionFromRequest(request);
    if (!session) {
      throw new AppError("UNAUTHORIZED", "会话无效或已过期。", 401);
    }
    requireCsrf(request, session);
    httpLimiter.take(`profile:${session.userId}`, 10, 60_000);
    const parsedProfile = profileInputSchema.safeParse(request.body);
    if (!parsedProfile.success) {
      throw new AppError(
        "INVALID_PROFILE",
        "需要提供昵称和思考状态。",
      );
    }
    session.profile = {
      nickname: validateNickname(parsedProfile.data.nickname),
      typingStatus: validateTypingStatus(parsedProfile.data.typingStatus),
    };
    if (session.accountAuthenticated) {
      const account = await authService.getUser(session.userId);
      account.nickname = session.profile.nickname;
      account.typingStatus = session.profile.typingStatus;
      account.updatedAt = new Date();
      await authRepository.updateUser(account);
      session.databaseUserId = account.id;
    } else if (gameRepository) {
      const databaseUser = await gameRepository.upsertGuest({
        sessionTokenHash: session.tokenHash,
        nickname: session.profile.nickname,
        typingStatus: session.profile.typingStatus,
      });
      session.databaseUserId = databaseUser.id;
    }
    return { profile: session.profile };
  });

  app.post("/api/ws-ticket", async (request) => {
    const session = await sessionFromRequest(request);
    if (!session) {
      throw new AppError("UNAUTHORIZED", "会话无效或已过期。", 401);
    }
    requireCsrf(request, session);
    if (session.accountAuthenticated) {
      await authService.assertAccountCapability(session.userId, "MATCH");
    }
    httpLimiter.take(`ws-ticket:${session.userId}`, 12, 60_000);
    const issued = await wsTickets.issue({
      userId: session.userId,
      sessionId: session.tokenHash,
    });
    return { wsTicket: issued.ticket, expiresAt: issued.expiresAt };
  });

  app.post("/api/session/logout", async (request, reply) => {
    const session = await sessionFromRequest(request);
    if (!session) {
      throw new AppError("UNAUTHORIZED", "会话无效或已过期。", 401);
    }
    requireCsrf(request, session);
    sessions.delete(session.tokenHash);
    session.socket?.close(4003, "Session revoked");
    reply.header(
      "set-cookie",
      serializeSessionCookie("", cookiePolicy, {
        maxAgeSeconds: 0,
        expires: new Date(0),
      }),
    );
    return { loggedOut: true };
  });

  app.get<{
    Querystring: { status?: ReportStatus; reportedUserId?: string };
  }>("/api/admin/reports", async (request) => {
    requireAdmin(request, "REPORT_READ");
    if (databaseReportRepository) {
      const persistentStatus = request.query.status
        ? ({
            OPEN: "pending",
            UNDER_REVIEW: "reviewing",
            ACTIONED: "resolved",
            DISMISSED: "dismissed",
          } as const)[request.query.status]
        : undefined;
      const reports = await databaseReportRepository.list(
        persistentStatus,
        100,
      );
      return { reports, persistence: "postgresql" };
    }
    const reports = await safetyReportRepository.list({
      status: request.query.status,
      reportedUserId: request.query.reportedUserId,
      limit: 100,
    });
    return { reports };
  });

  app.post<{
    Params: { reportId: string };
    Body: { status?: ReportStatus; note?: string };
  }>("/api/admin/reports/:reportId", async (request) => {
    const authentication = requireAdmin(request, "REPORT_DECIDE");
    const status = request.body?.status;
    if (
      status !== "UNDER_REVIEW" &&
      status !== "ACTIONED" &&
      status !== "DISMISSED"
    ) {
      throw new AppError("INVALID_REPORT_STATUS", "举报状态无效。");
    }
    if (databaseReportRepository) {
      const persistentStatus =
        status === "UNDER_REVIEW"
          ? "reviewing"
          : status === "ACTIONED"
            ? "resolved"
            : "dismissed";
      const report = await databaseReportRepository.setStatus(
        request.params.reportId,
        persistentStatus,
        request.body.note,
      );
      if (!report) {
        throw new AppError("REPORT_NOT_FOUND", "举报不存在。", 404);
      }
      return { report, persistence: "postgresql" };
    }
    const report = await reportService.transition(
      request.params.reportId,
      status,
      {
        actorId: authentication.principal.id,
        traceId: request.id,
      },
      request.body.note,
    );
    return { report };
  });

  app.post<{
    Body: {
      scope?: BanScope;
      identifier?: string;
      reasonCode?: BanReasonCode;
      durationMs?: number;
      note?: string;
    };
  }>("/api/admin/bans", async (request, reply) => {
    const authentication = requireAdmin(request, "BAN_ISSUE");
    const { scope, identifier, reasonCode, durationMs, note } =
      request.body ?? {};
    if (
      !scope ||
      !["USER", "SESSION", "IP", "DEVICE"].includes(scope) ||
      !identifier?.trim() ||
      !reasonCode
    ) {
      throw new AppError("INVALID_BAN", "封禁参数无效。");
    }
    if (databaseBanRepository) {
      const existing = await databaseBanRepository.findActive(
        scope.toLowerCase() as "user" | "session" | "device" | "ip",
        banService.hashSubject(scope, identifier),
      );
      if (existing) {
        return { ban: existing, persistence: "postgresql" };
      }
    }
    const ban = await banService.issue({
      scope,
      identifier,
      reasonCode,
      durationMs,
      note,
      audit: {
        actorId: authentication.principal.id,
        traceId: request.id,
      },
    });
    if (databaseBanRepository) {
      await databaseBanRepository.create({
        id: ban.id,
        scope: ban.scope.toLowerCase() as
          | "user"
          | "session"
          | "device"
          | "ip",
        identityHash: ban.subjectHash,
        reason: ban.reasonCode,
        createdBy: authentication.principal.id,
        expiresAt: ban.expiresAt ? new Date(ban.expiresAt) : null,
      });
    }
    reply.status(201);
    return { ban };
  });

  app.post<{
    Params: { banId: string };
  }>("/api/admin/bans/:banId/revoke", async (request) => {
    const authentication = requireAdmin(request, "BAN_REVOKE");
    const persistent = databaseBanRepository
      ? await databaseBanRepository.revoke(
          request.params.banId,
          authentication.principal.id,
        )
      : null;
    let memoryBan;
    try {
      memoryBan = await banService.revoke(request.params.banId, {
        actorId: authentication.principal.id,
        traceId: request.id,
      });
    } catch {
      if (!persistent) {
        throw new AppError("BAN_NOT_FOUND", "封禁不存在。", 404);
      }
    }
    return { ban: persistent ?? memoryBan };
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  app.server.on("upgrade", (request, socket, head) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    const originDecision = originPolicy.evaluateWebSocket(
      request.headers.origin,
    );
    if (url.pathname !== "/ws" || !originDecision.allowed) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const ticket = url.searchParams.get("ticket");
    if (!ticket) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    void wsTickets
      .consume(ticket)
      .then(async (payload) => {
        const session = payload
          ? sessions.get(payload.sessionId)
          : undefined;
        if (
          !payload ||
          !session ||
          payload.userId !== session.userId ||
          session.expiresAt <= Date.now() ||
          session.idleExpiresAt <= Date.now()
        ) {
          socket.write(
            "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n",
          );
          socket.destroy();
          return;
        }
        const handshakeLimit = await compositeLimiter.consume({
          operation: "ws.handshake",
          identity: {
            ip: session.ipHash,
            deviceId: session.deviceId,
            sessionId: session.sessionId,
            userId: session.userId,
          },
        });
        if (!handshakeLimit.allowed) {
          socket.write(
            "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n",
          );
          socket.destroy();
          return;
        }
        if (await isBlocked("USER", session.userId)) {
          socket.write(
            "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n",
          );
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (webSocket) => {
          wss.emit("connection", webSocket, session);
        });
      })
      .catch((error) => {
        app.log.warn({ error }, "websocket ticket validation failed");
        socket.destroy();
      });
  });

  wss.on("connection", (socket: WebSocket, session: Session) => {
    if (session.socket && session.socket.readyState === session.socket.OPEN) {
      session.socket.close(4001, "Replaced by a newer connection");
    }
    games.reconnect(session, socket);
    send(socket, {
      type: "session.ready",
      userId: session.userId,
    });

    socket.on("message", (raw) => {
      void handleWsMessage(
        raw,
        session,
        games,
        wsLimiter,
        consumeGameRateLimit,
        reportService,
        () => touchWebSocketSession(session),
        async () => {
          if (session.accountAuthenticated) {
            try {
              await authService.assertAccountCapability(
                session.userId,
                "MATCH",
              );
            } catch (error) {
              if (error instanceof AuthError) {
                throw new AppError(
                  error.code,
                  error.message,
                  403,
                );
              }
              throw error;
            }
          }
        },
      );
    });
    socket.on("close", () => {
      if (session.socket === socket) {
        session.socket = undefined;
        games.handleDisconnect(session);
      }
    });
    socket.on("error", (error) => {
      app.log.warn(
        { userId: session.userId, error: error.message },
        "websocket error",
      );
    });
  });

  app.addHook("onClose", async () => {
    if (retentionTimer) {
      clearInterval(retentionTimer);
    }
    for (const client of wss.clients) {
      client.terminate();
    }
    games.shutdown();
    wss.close();
    await feedbackDigestWorker?.stop();
    qqEmailDelivery?.close();
    await redis.close();
    if (database.available) {
      await database.close();
    }
  });
  if (options.feedbackDigest?.autoStart !== false) {
    feedbackDigestWorker?.start();
  }

  return {
    app,
    sessions,
    games,
    wss,
    redis,
    database,
    auth: {
      repository: authRepository,
      service: authService,
      sessions: accountSessions,
      devices: deviceService,
      registrationOpen,
      emailConfigured,
    },
    feedback: {
      configured: Boolean(feedbackDigestWorker),
      worker: feedbackDigestWorker,
    },
    echo: {
      configured: Boolean(echoArchiveService),
      service: echoArchiveService,
    },
  };
}

async function handleWsMessage(
  raw: RawData,
  session: Session,
  games: GameService,
  limiter: SlidingWindowLimiter,
  consumeComposite: (
    operation: RateLimitOperation,
    session: Session,
  ) => Promise<void>,
  reportService: ReportService,
  touchSession: () => Promise<void>,
  assertCanMatch: () => Promise<void>,
): Promise<void> {
  const socket = session.socket;
  if (!socket) return;
  let envelope: ClientEvent;
  try {
    limiter.take(`ws:${session.userId}`, 40, 10_000);
    if (rawDataSize(raw) > 4 * 1024) {
      throw new AppError("PAYLOAD_TOO_LARGE", "消息体过大。");
    }
    const parsedEvent = clientEventSchema.safeParse(
      JSON.parse(raw.toString()),
    );
    if (!parsedEvent.success) {
      throw new AppError("INVALID_EVENT", "事件格式无效。");
    }
    await touchSession();
    envelope = parsedEvent.data;
    switch (envelope.type) {
      case "match.join":
        await assertCanMatch();
        limiter.take(`queue:${session.userId}`, 5, 60_000);
        await consumeComposite("match.join", session);
        games.joinQueue(session);
        break;
      case "match.cancel":
        await consumeComposite("match.cancel", session);
        games.leaveQueue(session);
        break;
      case "chat.send": {
        limiter.take(`chat:${session.userId}`, 10, 10_000);
        await consumeComposite("chat.send", session);
        games.sendChat(
          session,
          envelope.content,
          envelope.clientMessageId,
        );
        break;
      }
      case "chat.typing_start": {
        await consumeComposite("chat.typing", session);
        games.setTyping(session, true);
        break;
      }
      case "chat.typing_stop": {
        await consumeComposite("chat.typing", session);
        games.setTyping(session, false);
        break;
      }
      case "guess.submit": {
        games.submitGuess(
          session,
          envelope.targetGuess,
          envelope.clientGuessId,
        );
        break;
      }
      case "game.report": {
        limiter.take(`report:${session.userId}`, 3, 10 * 60_000);
        await consumeComposite("game.report", session);
        const report = await games.createReport(session, envelope.reason);
        await reportService.create({
          reporterId: session.userId,
          reasonCode: reportReasonCode(envelope.reason),
          description: envelope.details,
          evidence: {
            roomId: report.roomId,
            reportedUserId: report.reportedUserId,
            opponentType: report.evidence.opponentType,
            messages: report.evidence.messages.map((message) => ({
              messageId: message.id,
              senderPseudonym:
                message.senderId === session.userId
                  ? "reporter"
                  : "opponent",
              content: message.text,
              createdAt: new Date(message.at).toISOString(),
            })),
            roomStartedAt: new Date(
              report.evidence.messages[0]?.at ?? report.createdAt,
            ).toISOString(),
          },
          audit: {
            actorId: session.userId,
            ipHash: session.ipHash,
          },
        });
        send(socket, {
          type: "game.reported",
          reportId: report.id,
        });
        break;
      }
      case "game.leave":
        games.leaveGame(session);
        break;
      case "game.resume":
        await games.resumeRoom(session, envelope.lastSequence);
        break;
      case "ping":
        send(socket, {
          type: "pong",
          now: Date.now(),
        });
        break;
      default:
        throw new AppError("UNKNOWN_EVENT", "不支持的事件类型。");
    }
  } catch (error) {
    const body = errorBody(error).error;
    send(socket, {
      type: "game.error",
      code: body.code,
      message: body.message,
    });
  }
}

function rawDataSize(raw: RawData): number {
  return Array.isArray(raw)
    ? raw.reduce((total, chunk) => total + chunk.byteLength, 0)
    : raw.byteLength;
}

function reportReasonCode(reason: string): ReportReasonCode {
  const normalized = reason.trim().toLowerCase();
  const mapping: Record<string, ReportReasonCode> = {
    harassment: "HARASSMENT",
    sexual: "SEXUAL",
    personal_info: "PERSONAL_DATA",
    self_harm: "SELF_HARM",
    spam: "SCAM",
    threat: "THREAT",
    hate: "HATE",
    minor_safety: "MINOR_SAFETY",
    other: "OTHER",
  };
  return mapping[normalized] ?? "OTHER";
}

function send(socket: WebSocket, envelope: WsEnvelope): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(envelope));
  }
}
