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
    status: accountStatusSchema,
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

export const logoutRequestSchema = z.object({}).strict();
export const logoutResponseSchema = z
  .object({
    loggedOut: z.literal(true),
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
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;
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
