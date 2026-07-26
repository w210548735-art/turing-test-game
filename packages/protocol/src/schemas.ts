import { z } from "zod";

export const identitySchema = z.enum(["human", "ai"]);
export const confidenceSchema = z.number().int().min(0).max(100);

export const emailSchema = z.string().trim().email().max(254);
export const passwordSchema = z.string().min(12).max(128);
export const accountStatusSchema = z.enum([
  "PENDING_EMAIL",
  "ACTIVE",
  "LIMITED",
  "SUSPENDED",
  "BANNED",
  "DELETED",
]);
export const accountRoleSchema = z.enum(["PLAYER", "ROOT"]);

const publicAuthResultSchema = z
  .object({
    accepted: z.literal(true),
    message: z.string().min(1).max(200),
  })
  .strict();

const accountUserSchema = z
  .object({
    id: z.string().uuid(),
    email: emailSchema,
    playerNumber: z.number().int().min(100_001),
    displayName: z.string().trim().min(2).max(18),
    status: accountStatusSchema,
    role: accountRoleSchema,
  })
  .strict();

export const adminDashboardResponseSchema = z
  .object({
    generatedAt: z.string().datetime(),
    databaseMode: z.enum(["postgresql", "memory-demo"]),
    metrics: z
      .object({
        registeredUsers: z.number().int().nonnegative(),
        newUsersToday: z.number().int().nonnegative(),
        newUsers7d: z.number().int().nonnegative(),
        previous7dUsers: z.number().int().nonnegative(),
        visitsToday: z.number().int().nonnegative(),
        visits7d: z.number().int().nonnegative(),
        previous7dVisits: z.number().int().nonnegative(),
        verifiedUsers: z.number().int().nonnegative(),
        pendingVerificationUsers: z.number().int().nonnegative(),
        activeSessions: z.number().int().nonnegative(),
        onlineUsers: z.number().int().nonnegative(),
        totalGames: z.number().int().nonnegative(),
        activeGames: z.number().int().nonnegative(),
        humanGames: z.number().int().nonnegative(),
        aiGames: z.number().int().nonnegative(),
        waitingPlayers: z.number().int().nonnegative(),
        admittingPlayers: z.number().int().nonnegative(),
        roomCapacity: z.number().int().positive(),
        savedEchoArchives: z.number().int().nonnegative(),
        pendingFeedback: z.number().int().nonnegative(),
        pendingReports: z.number().int().nonnegative(),
        aiRequestsThisHour: z.number().int().nonnegative(),
        tokensToday: z.number().int().nonnegative(),
        tokenBudgetToday: z.number().int().positive(),
      })
      .strict(),
    daily: z
      .array(
        z
          .object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
            registrations: z.number().int().nonnegative(),
            visits: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .length(7),
  })
  .strict();

export const registerAccountRequestSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
  })
  .strict();

export const registerAccountResponseSchema = publicAuthResultSchema;

export const verifyEmailRequestSchema = z
  .object({
    token: z.string().min(20).max(512),
  })
  .strict();

export const verifyEmailResponseSchema = z
  .object({
    verified: z.literal(true),
  })
  .strict();

export const loginAccountRequestSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
  })
  .strict();

export const accountSessionResponseSchema = z
  .object({
    authenticated: z.literal(true),
    user: accountUserSchema,
    csrfToken: z.string().min(20).max(512),
    sessionExpiresAt: z.number().int().positive(),
    wsTicket: z.string().min(20).max(512).optional(),
    wsTicketExpiresAt: z.number().int().positive().optional(),
  })
  .strict();

export const bootstrapAccountRequestSchema = z.object({}).strict();
export const bootstrapAccountResponseSchema = accountSessionResponseSchema;

export const accountProfileInputSchema = z
  .object({
    displayName: z.string().trim().min(2).max(18),
  })
  .strict();

export const accountProfileResponseSchema = z
  .object({
    user: accountUserSchema,
  })
  .strict();

export const forgotPasswordRequestSchema = z
  .object({
    email: emailSchema,
  })
  .strict();

export const forgotPasswordResponseSchema = publicAuthResultSchema;

export const resetPasswordRequestSchema = z
  .object({
    token: z.string().min(20).max(512),
    newPassword: passwordSchema,
  })
  .strict();

export const resetPasswordResponseSchema = z
  .object({
    reset: z.literal(true),
  })
  .strict();

export const changePasswordRequestSchema = z
  .object({
    currentPassword: passwordSchema,
    newPassword: passwordSchema,
  })
  .strict();

export const changePasswordResponseSchema = z
  .object({
    changed: z.literal(true),
  })
  .strict();

export const deleteAccountRequestSchema = z
  .object({
    currentPassword: passwordSchema,
    confirmation: z.literal("注销"),
  })
  .strict();

export const deleteAccountResponseSchema = z
  .object({
    deleted: z.literal(true),
  })
  .strict();

export const logoutRequestSchema = z.object({}).strict();
export const logoutResponseSchema = z
  .object({
    loggedOut: z.literal(true),
  })
  .strict();

export const feedbackCategorySchema = z.enum([
  "bug",
  "suggestion",
  "other",
]);

export const archiveConsentDecisionSchema = z.enum([
  "approve",
  "decline",
]);

export const submitArchiveConsentRequestSchema = z
  .object({
    decision: archiveConsentDecisionSchema,
    clientRequestId: z.string().uuid(),
  })
  .strict();

export const archiveConsentResponseSchema = z
  .object({
    accepted: z.literal(true),
    message: z.string().min(1).max(200),
  })
  .strict();

export const echoReplayEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    type: z.enum([
      "typing.start",
      "typing.stop",
      "message.visible",
    ]),
    actor: z.enum(["A", "B"]),
    offsetMs: z.number().int().nonnegative(),
    content: z.string().max(100).optional(),
    moderated: z.boolean().optional(),
  })
  .strict();

export const echoAssignmentResponseSchema = z
  .object({
    assignmentId: z.string().uuid(),
    archiveId: z.string().uuid(),
    status: z.literal("active"),
    expiresInSeconds: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    events: z.array(echoReplayEventSchema).max(500),
  })
  .strict();

export const submitEchoJudgmentRequestSchema = z
  .object({
    guessA: identitySchema,
    confidenceA: confidenceSchema,
    guessB: identitySchema,
    confidenceB: confidenceSchema,
    clientRequestId: z.string().uuid(),
  })
  .strict();

export const submitEchoJudgmentResponseSchema = z
  .object({
    completed: z.literal(true),
    identities: z
      .object({
        A: identitySchema,
        B: identitySchema,
      })
      .strict(),
    correct: z
      .object({
        A: z.boolean(),
        B: z.boolean(),
      })
      .strict(),
    correctCount: z.number().int().min(0).max(2),
    bothCorrect: z.boolean(),
    scoreDelta: z.number().int(),
    confidenceCalibration: z.number().int().min(0).max(100),
    stats: z
      .object({
        reviewsPlayed: z.number().int().nonnegative(),
        identitiesCorrect: z.number().int().nonnegative(),
        perfectJudgments: z.number().int().nonnegative(),
        score: z.number().int(),
      })
      .strict(),
  })
  .strict();

export const echoRecordEntrySchema = z
  .object({
    id: z.string().uuid(),
    submittedAt: z.string().datetime(),
    identities: z
      .object({
        A: identitySchema,
        B: identitySchema,
      })
      .strict(),
    guesses: z
      .object({
        A: identitySchema,
        B: identitySchema,
      })
      .strict(),
    confidence: z
      .object({
        A: confidenceSchema,
        B: confidenceSchema,
      })
      .strict(),
    correct: z
      .object({
        A: z.boolean(),
        B: z.boolean(),
      })
      .strict(),
    correctCount: z.number().int().min(0).max(2),
    bothCorrect: z.boolean(),
    scoreDelta: z.number().int(),
    confidenceCalibration: z.number().int().min(0).max(100),
    durationMs: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative(),
  })
  .strict();

export const echoRecordsResponseSchema = z
  .object({
    stats: z
      .object({
        reviewsPlayed: z.number().int().nonnegative(),
        identitiesCorrect: z.number().int().nonnegative(),
        perfectJudgments: z.number().int().nonnegative(),
        score: z.number().int(),
      })
      .strict(),
    records: z.array(echoRecordEntrySchema).max(50),
  })
  .strict();

export const echoCommentSchema = z
  .object({
    id: z.string().uuid(),
    eventSequence: z.number().int().positive(),
    authorAlias: z.string().min(1).max(40),
    content: z.string().min(2).max(200),
    createdAt: z.string().datetime(),
    likeCount: z.number().int().nonnegative(),
    likedByMe: z.boolean(),
    mine: z.boolean(),
  })
  .strict();

export const echoCommentsResponseSchema = z
  .object({
    comments: z.array(echoCommentSchema).max(500),
    countsByEventSequence: z.record(
      z.string().regex(/^[1-9]\d*$/u),
      z.number().int().nonnegative(),
    ),
  })
  .strict();

export const submitEchoCommentRequestSchema = z
  .object({
    eventSequence: z.number().int().positive(),
    content: z.string().trim().min(2).max(200),
    clientRequestId: z.string().uuid(),
  })
  .strict();

export const echoCommentLikeResponseSchema = z
  .object({
    commentId: z.string().uuid(),
    liked: z.boolean(),
    likeCount: z.number().int().nonnegative(),
  })
  .strict();

export const deleteEchoCommentResponseSchema = z
  .object({
    commentId: z.string().uuid(),
    deleted: z.literal(true),
  })
  .strict();

export const submitFeedbackRequestSchema = z
  .object({
    category: feedbackCategorySchema,
    title: z.string().trim().min(2).max(80),
    details: z.string().trim().min(10).max(2_000),
  })
  .strict();

export const submitFeedbackResponseSchema = z
  .object({
    accepted: z.literal(true),
    feedbackId: z.string().uuid(),
    message: z.string().min(1).max(200),
  })
  .strict();

export const profileInputSchema = z.object({
  nickname: z.string().min(2).max(18),
  typingStatus: z.string().min(1).max(30),
});

export const sessionResponseSchema = z.object({
  userId: z.string().uuid(),
  csrfToken: z.string().min(20),
  wsTicket: z.string().min(20).optional(),
  wsTicketExpiresAt: z.number().int().positive().optional(),
  sessionExpiresAt: z.number().int().positive(),
});

export const chatMessageSchema = z.object({
  id: z.string().min(1),
  sender: z.enum(["self", "opponent", "system"]),
  content: z.string().max(100),
  sequence: z.number().int().positive(),
  createdAt: z.union([z.number(), z.string()]),
  moderated: z.boolean().optional(),
});

export const clientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("match.join") }),
  z.object({ type: z.literal("match.cancel") }),
  z.object({
    type: z.literal("chat.send"),
    content: z.string().min(1).max(100),
    clientMessageId: z.string().min(8).max(100),
  }),
  z.object({ type: z.literal("chat.typing_start") }),
  z.object({ type: z.literal("chat.typing_stop") }),
  z.object({
    type: z.literal("guess.submit"),
    targetGuess: identitySchema,
    confidence: confidenceSchema,
    clientGuessId: z.string().min(8).max(100).optional(),
  }),
  z.object({
    type: z.literal("game.report"),
    reason: z.string().min(2).max(80),
    details: z.string().max(300),
  }),
  z.object({ type: z.literal("game.leave") }),
  z.object({
    type: z.literal("game.resume"),
    lastSequence: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("ping") }),
]);

const gameStatsSchema = z.object({
  durationSeconds: z.number().nonnegative().optional(),
  messageCount: z.number().int().nonnegative().optional(),
  streak: z.number().int().nonnegative().optional(),
  scoreDelta: z.number().int().optional(),
});

export const serverEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.ready"),
    userId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("match.queued"),
    position: z.number().int().positive(),
    queuedAt: z.union([z.number(), z.string()]),
  }),
  z.object({
    type: z.literal("match.searching"),
    searchStartedAt: z.union([z.number(), z.string()]),
  }),
  z.object({
    type: z.literal("match.admission"),
    gateEndsAt: z.union([z.number(), z.string()]),
  }),
  z.object({
    type: z.literal("match.progress"),
    progress: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal("match.found"),
    gameId: z.string().min(1),
    startedAt: z.union([z.number(), z.string()]),
    endsAt: z.union([z.number(), z.string()]),
    minGuessAt: z.union([z.number(), z.string()]),
    opponentLabel: z.string().min(1).max(40),
  }),
  chatMessageSchema.extend({ type: z.literal("chat.message") }),
  z.object({
    type: z.literal("chat.typing_start"),
    status: z.string().max(30).optional(),
  }),
  z.object({ type: z.literal("chat.typing_stop") }),
  z.object({
    type: z.literal("guess.accepted"),
    targetGuess: identitySchema.optional(),
  }),
  z.object({
    type: z.literal("game.finished"),
    opponentType: identitySchema,
    guess: identitySchema.nullable(),
    isCorrect: z.boolean(),
    outcome: z.string(),
    archiveConsentEligible: z.boolean(),
    stats: gameStatsSchema.optional(),
  }),
  z.object({
    type: z.literal("game.error"),
    message: z.string().optional(),
    code: z.string().optional(),
  }),
  z.object({
    type: z.literal("game.disconnected"),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal("game.reconnected"),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal("game.reported"),
    reportId: z.string().optional(),
  }),
  z.object({
    type: z.literal("game.snapshot"),
    gameId: z.string(),
    status: z.string(),
    lastSequence: z.number().int().nonnegative(),
    messages: z.array(chatMessageSchema),
  }),
  z.object({
    type: z.literal("pong"),
    now: z.number(),
  }),
]);

export type Identity = z.infer<typeof identitySchema>;
export type AccountStatus = z.infer<typeof accountStatusSchema>;
export type AccountRole = z.infer<typeof accountRoleSchema>;
export type AdminDashboardResponse = z.infer<
  typeof adminDashboardResponseSchema
>;
export type RegisterAccountRequest = z.infer<
  typeof registerAccountRequestSchema
>;
export type RegisterAccountResponse = z.infer<
  typeof registerAccountResponseSchema
>;
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;
export type VerifyEmailResponse = z.infer<typeof verifyEmailResponseSchema>;
export type LoginAccountRequest = z.infer<typeof loginAccountRequestSchema>;
export type AccountSessionResponse = z.infer<
  typeof accountSessionResponseSchema
>;
export type AccountProfileInput = z.infer<typeof accountProfileInputSchema>;
export type AccountProfileResponse = z.infer<
  typeof accountProfileResponseSchema
>;
export type BootstrapAccountRequest = z.infer<
  typeof bootstrapAccountRequestSchema
>;
export type BootstrapAccountResponse = z.infer<
  typeof bootstrapAccountResponseSchema
>;
export type ForgotPasswordRequest = z.infer<
  typeof forgotPasswordRequestSchema
>;
export type ForgotPasswordResponse = z.infer<
  typeof forgotPasswordResponseSchema
>;
export type ResetPasswordRequest = z.infer<
  typeof resetPasswordRequestSchema
>;
export type ResetPasswordResponse = z.infer<
  typeof resetPasswordResponseSchema
>;
export type ChangePasswordRequest = z.infer<
  typeof changePasswordRequestSchema
>;
export type ChangePasswordResponse = z.infer<
  typeof changePasswordResponseSchema
>;
export type DeleteAccountRequest = z.infer<
  typeof deleteAccountRequestSchema
>;
export type DeleteAccountResponse = z.infer<
  typeof deleteAccountResponseSchema
>;
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;
export type FeedbackCategory = z.infer<typeof feedbackCategorySchema>;
export type ArchiveConsentDecision = z.infer<
  typeof archiveConsentDecisionSchema
>;
export type SubmitArchiveConsentRequest = z.infer<
  typeof submitArchiveConsentRequestSchema
>;
export type ArchiveConsentResponse = z.infer<
  typeof archiveConsentResponseSchema
>;
export type EchoReplayEvent = z.infer<typeof echoReplayEventSchema>;
export type EchoAssignmentResponse = z.infer<
  typeof echoAssignmentResponseSchema
>;
export type SubmitEchoJudgmentRequest = z.infer<
  typeof submitEchoJudgmentRequestSchema
>;
export type SubmitEchoJudgmentResponse = z.infer<
  typeof submitEchoJudgmentResponseSchema
>;
export type EchoRecordEntry = z.infer<typeof echoRecordEntrySchema>;
export type EchoRecordsResponse = z.infer<typeof echoRecordsResponseSchema>;
export type EchoComment = z.infer<typeof echoCommentSchema>;
export type EchoCommentsResponse = z.infer<
  typeof echoCommentsResponseSchema
>;
export type SubmitEchoCommentRequest = z.infer<
  typeof submitEchoCommentRequestSchema
>;
export type EchoCommentLikeResponse = z.infer<
  typeof echoCommentLikeResponseSchema
>;
export type DeleteEchoCommentResponse = z.infer<
  typeof deleteEchoCommentResponseSchema
>;
export type SubmitFeedbackRequest = z.infer<
  typeof submitFeedbackRequestSchema
>;
export type SubmitFeedbackResponse = z.infer<
  typeof submitFeedbackResponseSchema
>;
export type ProfileInput = z.infer<typeof profileInputSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ClientEvent = z.infer<typeof clientEventSchema>;
export type ServerEvent = z.infer<typeof serverEventSchema>;

export function parseClientEvent(input: unknown): ClientEvent {
  return clientEventSchema.parse(input);
}

export function parseServerEvent(input: unknown): ServerEvent {
  return serverEventSchema.parse(input);
}
