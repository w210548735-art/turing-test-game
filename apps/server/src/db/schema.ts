import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const userStatusEnum = pgEnum("user_status", [
  "pending_email",
  "active",
  "limited",
  "suspended",
  "banned",
  "deleted",
]);
export const verificationTokenPurposeEnum = pgEnum(
  "verification_token_purpose",
  ["verify_email", "reset_password", "change_email", "websocket_ticket"],
);
export const securityEventSeverityEnum = pgEnum("security_event_severity", [
  "info",
  "warning",
  "critical",
]);
export const gameStatusEnum = pgEnum("game_status", [
  "matching",
  "active",
  "settled",
  "cancelled",
]);
export const identityTypeEnum = pgEnum("identity_type", ["human", "ai"]);
export const settlementReasonEnum = pgEnum("settlement_reason", [
  "all_guessed",
  "player_guessed",
  "timeout",
  "disconnect",
  "cancelled",
]);
export const settlementOutcomeEnum = pgEnum("settlement_outcome", [
  "won",
  "lost",
  "draw",
  "cancelled",
]);
export const reportStatusEnum = pgEnum("report_status", [
  "pending",
  "reviewing",
  "resolved",
  "dismissed",
]);
export const moderationDecisionEnum = pgEnum("moderation_decision", [
  "allow",
  "replace",
  "block",
  "terminate",
]);
export const banScopeEnum = pgEnum("ban_scope", [
  "user",
  "session",
  "device",
  "ip",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionTokenHash: text("session_token_hash"),
    emailOriginal: text("email_original"),
    emailCanonical: text("email_canonical"),
    passwordHash: text("password_hash"),
    emailVerifiedAt: timestamp("email_verified_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastLoginAt: timestamp("last_login_at", {
      withTimezone: true,
      mode: "date",
    }),
    deletedAt: timestamp("deleted_at", {
      withTimezone: true,
      mode: "date",
    }),
    nickname: text("nickname").notNull(),
    typingStatus: text("typing_status").notNull(),
    status: userStatusEnum("status").notNull().default("active"),
    score: integer("score").notNull().default(0),
    gamesPlayed: integer("games_played").notNull().default(0),
    correctGuesses: integer("correct_guesses").notNull().default(0),
    currentStreak: integer("current_streak").notNull().default(0),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("users_session_token_hash_uidx").on(table.sessionTokenHash),
    uniqueIndex("users_email_canonical_uidx").on(table.emailCanonical),
    index("users_status_last_seen_idx").on(table.status, table.lastSeenAt),
    check(
      "users_email_canonical_normalized",
      sql`${table.emailCanonical} IS NULL OR ${table.emailCanonical} = lower(btrim(${table.emailCanonical}))`,
    ),
    check("users_games_played_nonnegative", sql`${table.gamesPlayed} >= 0`),
    check(
      "users_correct_guesses_nonnegative",
      sql`${table.correctGuesses} >= 0`,
    ),
  ],
);

export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    tokenHash: text("token_hash").notNull(),
    label: text("label"),
    userAgentHash: text("user_agent_hash"),
    ipHash: text("ip_hash"),
    trustedAt: timestamp("trusted_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastSeenAt: timestamp("last_seen_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", {
      withTimezone: true,
      mode: "date",
    }),
    riskScore: integer("risk_score").notNull().default(0),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("devices_token_hash_uidx").on(table.tokenHash),
    index("devices_user_last_seen_idx").on(table.userId, table.lastSeenAt),
    index("devices_user_revoked_idx").on(table.userId, table.revokedAt),
    check("devices_risk_score_nonnegative", sql`${table.riskScore} >= 0`),
  ],
);

export const deviceAccounts = pgTable(
  "device_accounts",
  {
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    linkedAt: timestamp("linked_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "device_accounts_device_user_pk",
      columns: [table.deviceId, table.userId],
    }),
    index("device_accounts_user_linked_idx").on(
      table.userId,
      table.linkedAt,
    ),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id").references(() => devices.id, {
      onDelete: "set null",
    }),
    tokenHash: text("token_hash").notNull(),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    ipHash: text("ip_hash"),
    userAgentHash: text("user_agent_hash"),
    lastSeenAt: timestamp("last_seen_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    idleExpiresAt: timestamp("idle_expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    absoluteExpiresAt: timestamp("absolute_expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    revokedAt: timestamp("revoked_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_uidx").on(table.tokenHash),
    index("sessions_user_active_idx").on(
      table.userId,
      table.revokedAt,
      table.absoluteExpiresAt,
    ),
    index("sessions_device_last_seen_idx").on(
      table.deviceId,
      table.lastSeenAt,
    ),
    check(
      "sessions_expiry_order",
      sql`${table.idleExpiresAt} <= ${table.absoluteExpiresAt}`,
    ),
  ],
);

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: verificationTokenPurposeEnum("purpose").notNull(),
    tokenHash: text("token_hash").notNull(),
    targetEmailCanonical: text("target_email_canonical"),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    usedAt: timestamp("used_at", {
      withTimezone: true,
      mode: "date",
    }),
    revokedAt: timestamp("revoked_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("verification_tokens_token_hash_uidx").on(table.tokenHash),
    index("verification_tokens_user_purpose_idx").on(
      table.userId,
      table.purpose,
      table.createdAt,
    ),
    index("verification_tokens_expiry_idx").on(
      table.expiresAt,
      table.usedAt,
      table.revokedAt,
    ),
    check(
      "verification_tokens_target_email_normalized",
      sql`${table.targetEmailCanonical} IS NULL OR ${table.targetEmailCanonical} = lower(btrim(${table.targetEmailCanonical}))`,
    ),
  ],
);

export interface SecurityEventMetadata {
  reason?: string;
  riskScore?: number;
  requestId?: string;
  [key: string]: unknown;
}

export const securityEvents = pgTable(
  "security_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    deviceId: uuid("device_id").references(() => devices.id, {
      onDelete: "set null",
    }),
    eventType: text("event_type").notNull(),
    severity: securityEventSeverityEnum("severity").notNull().default("info"),
    ipHash: text("ip_hash"),
    metadata: jsonb("metadata")
      .$type<SecurityEventMetadata>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("security_events_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
    index("security_events_type_created_idx").on(
      table.eventType,
      table.createdAt,
    ),
    index("security_events_session_idx").on(table.sessionId),
  ],
);

export const games = pgTable(
  "games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: gameStatusEnum("status").notNull().default("matching"),
    matchType: identityTypeEnum("match_type").notNull(),
    rulesetVersion: text("ruleset_version").notNull(),
    aiModel: text("ai_model"),
    aiProfileVersion: text("ai_profile_version"),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "date",
    }),
    endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }),
    settledAt: timestamp("settled_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("games_status_created_idx").on(table.status, table.createdAt),
    index("games_match_type_created_idx").on(table.matchType, table.createdAt),
    check(
      "games_ai_metadata_consistent",
      sql`(${table.matchType} = 'ai' AND ${table.aiModel} IS NOT NULL AND ${table.aiProfileVersion} IS NOT NULL) OR (${table.matchType} = 'human' AND ${table.aiModel} IS NULL AND ${table.aiProfileVersion} IS NULL)`,
    ),
  ],
);

export const gameParticipants = pgTable(
  "game_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    identityType: identityTypeEnum("identity_type").notNull(),
    seat: integer("seat").notNull(),
    joinedQueueAt: timestamp("joined_queue_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    joinedAt: timestamp("joined_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    disconnectedAt: timestamp("disconnected_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("game_participants_game_seat_uidx").on(
      table.gameId,
      table.seat,
    ),
    uniqueIndex("game_participants_game_user_uidx").on(
      table.gameId,
      table.userId,
    ),
    index("game_participants_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
    check("game_participants_seat_valid", sql`${table.seat} BETWEEN 0 AND 1`),
    check(
      "game_participants_identity_user_consistent",
      sql`(${table.identityType} = 'human' AND ${table.userId} IS NOT NULL) OR (${table.identityType} = 'ai' AND ${table.userId} IS NULL)`,
    ),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    senderParticipantId: uuid("sender_participant_id").references(
      () => gameParticipants.id,
      { onDelete: "set null" },
    ),
    senderType: identityTypeEnum("sender_type").notNull(),
    content: text("content").notNull(),
    clientMessageId: text("client_message_id"),
    serverSequence: integer("server_sequence").notNull(),
    moderated: boolean("moderated").notNull().default(false),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("messages_game_sequence_uidx").on(
      table.gameId,
      table.serverSequence,
    ),
    uniqueIndex("messages_game_client_message_uidx").on(
      table.gameId,
      table.clientMessageId,
    ),
    index("messages_game_created_idx").on(table.gameId, table.createdAt),
    check(
      "messages_server_sequence_positive",
      sql`${table.serverSequence} > 0`,
    ),
    check(
      "messages_sender_consistent",
      sql`(${table.senderType} = 'human' AND ${table.senderParticipantId} IS NOT NULL) OR (${table.senderType} = 'ai')`,
    ),
  ],
);

export const guesses = pgTable(
  "guesses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => gameParticipants.id, { onDelete: "cascade" }),
    targetGuess: identityTypeEnum("target_guess").notNull(),
    submittedAt: timestamp("submitted_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("guesses_game_participant_uidx").on(
      table.gameId,
      table.participantId,
    ),
    index("guesses_game_submitted_idx").on(table.gameId, table.submittedAt),
  ],
);

export const settlements = pgTable(
  "settlements",
  {
    settlementId: uuid("settlement_id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => gameParticipants.id, { onDelete: "cascade" }),
    reason: settlementReasonEnum("reason").notNull(),
    opponentType: identityTypeEnum("opponent_type").notNull(),
    playerGuess: identityTypeEnum("player_guess"),
    correct: boolean("correct"),
    outcome: settlementOutcomeEnum("outcome").notNull(),
    scoreDelta: integer("score_delta").notNull().default(0),
    durationMs: integer("duration_ms").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("settlements_game_participant_uidx").on(
      table.gameId,
      table.participantId,
    ),
    index("settlements_game_created_idx").on(table.gameId, table.createdAt),
    check("settlements_duration_nonnegative", sql`${table.durationMs} >= 0`),
  ],
);

export interface ReportEvidence {
  opponentType: "human" | "ai";
  messageIds: string[];
  snapshot: Array<{
    id: string;
    sender: "self" | "opponent";
    text: string;
    at: number;
    sequence: number;
  }>;
}

export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "restrict" }),
    reporterUserId: uuid("reporter_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reportedParticipantId: uuid("reported_participant_id").references(
      () => gameParticipants.id,
      { onDelete: "set null" },
    ),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").$type<ReportEvidence>().notNull(),
    status: reportStatusEnum("status").notNull().default("pending"),
    reviewerNote: text("reviewer_note"),
    reviewedAt: timestamp("reviewed_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("reports_status_created_idx").on(table.status, table.createdAt),
    index("reports_game_idx").on(table.gameId),
    index("reports_reporter_created_idx").on(
      table.reporterUserId,
      table.createdAt,
    ),
  ],
);

export interface ModerationMetadata {
  matchedRules?: string[];
  model?: string;
  providerRequestId?: string;
}

export const moderationEvents = pgTable(
  "moderation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id").references(() => games.id, {
      onDelete: "set null",
    }),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    source: text("source").notNull(),
    category: text("category").notNull(),
    decision: moderationDecisionEnum("decision").notNull(),
    riskScore: integer("risk_score").notNull().default(0),
    contentHash: text("content_hash"),
    metadata: jsonb("metadata").$type<ModerationMetadata>().notNull().default({}),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("moderation_events_decision_created_idx").on(
      table.decision,
      table.createdAt,
    ),
    index("moderation_events_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
    index("moderation_events_game_idx").on(table.gameId),
    check(
      "moderation_events_risk_score_range",
      sql`${table.riskScore} BETWEEN 0 AND 100`,
    ),
  ],
);

export const bans = pgTable(
  "bans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: banScopeEnum("scope").notNull(),
    identityHash: text("identity_hash").notNull(),
    reason: text("reason").notNull(),
    reportId: uuid("report_id").references(() => reports.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    revokedAt: timestamp("revoked_at", {
      withTimezone: true,
      mode: "date",
    }),
    revokedBy: text("revoked_by"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("bans_identity_lookup_idx").on(
      table.scope,
      table.identityHash,
      table.expiresAt,
    ),
    index("bans_created_idx").on(table.createdAt),
    check(
      "bans_revocation_consistent",
      sql`${table.revokedAt} IS NULL OR ${table.revokedBy} IS NOT NULL`,
    ),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type DeviceRow = typeof devices.$inferSelect;
export type NewDeviceRow = typeof devices.$inferInsert;
export type DeviceAccountRow = typeof deviceAccounts.$inferSelect;
export type NewDeviceAccountRow = typeof deviceAccounts.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type VerificationTokenRow = typeof verificationTokens.$inferSelect;
export type NewVerificationTokenRow = typeof verificationTokens.$inferInsert;
export type SecurityEventRow = typeof securityEvents.$inferSelect;
export type NewSecurityEventRow = typeof securityEvents.$inferInsert;
export type GameRow = typeof games.$inferSelect;
export type NewGameRow = typeof games.$inferInsert;
export type GameParticipantRow = typeof gameParticipants.$inferSelect;
export type NewGameParticipantRow = typeof gameParticipants.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
export type GuessRow = typeof guesses.$inferSelect;
export type NewGuessRow = typeof guesses.$inferInsert;
export type SettlementRow = typeof settlements.$inferSelect;
export type NewSettlementRow = typeof settlements.$inferInsert;
export type ReportRow = typeof reports.$inferSelect;
export type NewReportRow = typeof reports.$inferInsert;
export type ModerationEventRow = typeof moderationEvents.$inferSelect;
export type NewModerationEventRow = typeof moderationEvents.$inferInsert;
export type BanRow = typeof bans.$inferSelect;
export type NewBanRow = typeof bans.$inferInsert;
