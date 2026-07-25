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
export const feedbackCategoryEnum = pgEnum("feedback_category", [
  "bug",
  "suggestion",
  "other",
]);
export const feedbackDeliveryStatusEnum = pgEnum(
  "feedback_delivery_status",
  ["pending", "sent", "failed"],
);
export const feedbackDigestStatusEnum = pgEnum(
  "feedback_digest_status",
  ["pending", "sending", "sent", "failed"],
);
export const gameTimelineEventTypeEnum = pgEnum(
  "game_timeline_event_type",
  [
    "room_started",
    "typing_start",
    "typing_stop",
    "message_received",
    "message_visible",
  ],
);
export const echoArchiveStatusEnum = pgEnum("echo_archive_status", [
  "pending",
  "available",
  "rejected",
  "withdrawn",
]);
export const echoConsentDecisionEnum = pgEnum(
  "echo_consent_decision",
  ["approve", "decline"],
);
export const echoIdentityPatternEnum = pgEnum(
  "echo_identity_pattern",
  ["human_human", "human_ai", "ai_ai"],
);

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

export interface GameTimelineMetadata {
  moderated?: boolean;
}

export const gameTimelineEvents = pgTable(
  "game_timeline_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    eventSequence: integer("event_sequence").notNull(),
    eventType: gameTimelineEventTypeEnum("event_type").notNull(),
    actorParticipantId: uuid("actor_participant_id").references(
      () => gameParticipants.id,
      { onDelete: "set null" },
    ),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    metadata: jsonb("metadata")
      .$type<GameTimelineMetadata>()
      .notNull()
      .default({}),
  },
  (table) => [
    uniqueIndex("game_timeline_events_game_sequence_uidx").on(
      table.gameId,
      table.eventSequence,
    ),
    index("game_timeline_events_game_time_idx").on(
      table.gameId,
      table.occurredAt,
    ),
    check(
      "game_timeline_events_sequence_positive",
      sql`${table.eventSequence} > 0`,
    ),
  ],
);

export const echoArchives = pgTable(
  "echo_archives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceGameId: uuid("source_game_id").references(() => games.id, {
      onDelete: "set null",
    }),
    status: echoArchiveStatusEnum("status").notNull().default("pending"),
    identityPattern: echoIdentityPatternEnum("identity_pattern").notNull(),
    timelineVersion: text("timeline_version")
      .notNull()
      .default("echo-v1"),
    durationMs: integer("duration_ms").notNull(),
    consentExpiresAt: timestamp("consent_expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "date",
    }),
    withdrawnAt: timestamp("withdrawn_at", {
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
    uniqueIndex("echo_archives_source_game_uidx").on(table.sourceGameId),
    index("echo_archives_status_published_idx").on(
      table.status,
      table.publishedAt,
    ),
    check("echo_archives_duration_nonnegative", sql`${table.durationMs} >= 0`),
  ],
);

export const echoConsents = pgTable(
  "echo_consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => gameParticipants.id, { onDelete: "cascade" }),
    decision: echoConsentDecisionEnum("decision").notNull(),
    clientRequestId: uuid("client_request_id").notNull(),
    decidedAt: timestamp("decided_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("echo_consents_game_participant_uidx").on(
      table.gameId,
      table.participantId,
    ),
    uniqueIndex("echo_consents_client_request_uidx").on(table.clientRequestId),
  ],
);

export const echoArchiveSources = pgTable(
  "echo_archive_sources",
  {
    archiveId: uuid("archive_id")
      .notNull()
      .references(() => echoArchives.id, { onDelete: "cascade" }),
    publicSeat: integer("public_seat").notNull(),
    sourceParticipantId: uuid("source_participant_id").references(
      () => gameParticipants.id,
      { onDelete: "set null" },
    ),
    sourceUserId: uuid("source_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    identityType: identityTypeEnum("identity_type").notNull(),
  },
  (table) => [
    primaryKey({
      name: "echo_archive_sources_pk",
      columns: [table.archiveId, table.publicSeat],
    }),
    uniqueIndex("echo_archive_sources_participant_uidx").on(
      table.archiveId,
      table.sourceParticipantId,
    ),
    index("echo_archive_sources_user_idx").on(table.sourceUserId),
    check(
      "echo_archive_sources_seat_valid",
      sql`${table.publicSeat} BETWEEN 0 AND 1`,
    ),
  ],
);

export const echoArchiveEvents = pgTable(
  "echo_archive_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    archiveId: uuid("archive_id")
      .notNull()
      .references(() => echoArchives.id, { onDelete: "cascade" }),
    eventSequence: integer("event_sequence").notNull(),
    eventType: gameTimelineEventTypeEnum("event_type").notNull(),
    publicSeat: integer("public_seat").notNull(),
    offsetMs: integer("offset_ms").notNull(),
    content: text("content"),
    moderated: boolean("moderated").notNull().default(false),
  },
  (table) => [
    uniqueIndex("echo_archive_events_archive_sequence_uidx").on(
      table.archiveId,
      table.eventSequence,
    ),
    index("echo_archive_events_archive_offset_idx").on(
      table.archiveId,
      table.offsetMs,
    ),
    check(
      "echo_archive_events_seat_valid",
      sql`${table.publicSeat} BETWEEN 0 AND 1`,
    ),
    check("echo_archive_events_offset_nonnegative", sql`${table.offsetMs} >= 0`),
  ],
);

export const echoAssignments = pgTable(
  "echo_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    archiveId: uuid("archive_id")
      .notNull()
      .references(() => echoArchives.id, { onDelete: "cascade" }),
    reviewerUserId: uuid("reviewer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    uniqueIndex("echo_assignments_archive_reviewer_uidx").on(
      table.archiveId,
      table.reviewerUserId,
    ),
    index("echo_assignments_reviewer_expiry_idx").on(
      table.reviewerUserId,
      table.expiresAt,
    ),
  ],
);

export const echoJudgments = pgTable(
  "echo_judgments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => echoAssignments.id, { onDelete: "restrict" }),
    archiveId: uuid("archive_id")
      .notNull()
      .references(() => echoArchives.id, { onDelete: "restrict" }),
    reviewerUserId: uuid("reviewer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    guessA: identityTypeEnum("guess_a").notNull(),
    confidenceA: integer("confidence_a").notNull(),
    guessB: identityTypeEnum("guess_b").notNull(),
    confidenceB: integer("confidence_b").notNull(),
    correctCount: integer("correct_count").notNull(),
    bothCorrect: boolean("both_correct").notNull(),
    scoreDelta: integer("score_delta").notNull(),
    confidenceCalibration: integer("confidence_calibration").notNull(),
    clientRequestId: uuid("client_request_id").notNull(),
    submittedAt: timestamp("submitted_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("echo_judgments_assignment_uidx").on(table.assignmentId),
    uniqueIndex("echo_judgments_client_request_uidx").on(table.clientRequestId),
    index("echo_judgments_reviewer_submitted_idx").on(
      table.reviewerUserId,
      table.submittedAt,
    ),
    check(
      "echo_judgments_confidence_range",
      sql`${table.confidenceA} BETWEEN 0 AND 100 AND ${table.confidenceB} BETWEEN 0 AND 100`,
    ),
    check(
      "echo_judgments_correct_count_range",
      sql`${table.correctCount} BETWEEN 0 AND 2`,
    ),
    check(
      "echo_judgments_calibration_range",
      sql`${table.confidenceCalibration} BETWEEN 0 AND 100`,
    ),
  ],
);

export const echoReviewerStats = pgTable("echo_reviewer_stats", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  reviewsPlayed: integer("reviews_played").notNull().default(0),
  identitiesCorrect: integer("identities_correct").notNull().default(0),
  perfectJudgments: integer("perfect_judgments").notNull().default(0),
  score: integer("score").notNull().default(0),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "date",
  })
    .notNull()
    .defaultNow(),
});

export const echoCommentAuthors = pgTable(
  "echo_comment_authors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    archiveId: uuid("archive_id")
      .notNull()
      .references(() => echoArchives.id, { onDelete: "cascade" }),
    reviewerUserId: uuid("reviewer_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    alias: text("alias").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("echo_comment_authors_archive_reviewer_uidx").on(
      table.archiveId,
      table.reviewerUserId,
    ),
    uniqueIndex("echo_comment_authors_archive_alias_uidx").on(
      table.archiveId,
      table.alias,
    ),
  ],
);

export const echoComments = pgTable(
  "echo_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    archiveId: uuid("archive_id")
      .notNull()
      .references(() => echoArchives.id, { onDelete: "cascade" }),
    archiveEventId: uuid("archive_event_id")
      .notNull()
      .references(() => echoArchiveEvents.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => echoCommentAuthors.id, { onDelete: "cascade" }),
    authorAssignmentId: uuid("author_assignment_id").references(
      () => echoAssignments.id,
      { onDelete: "set null" },
    ),
    content: text("content").notNull(),
    clientRequestId: uuid("client_request_id").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("echo_comments_client_request_uidx").on(
      table.clientRequestId,
    ),
    index("echo_comments_archive_event_created_idx").on(
      table.archiveId,
      table.archiveEventId,
      table.createdAt,
    ),
    index("echo_comments_author_created_idx").on(
      table.authorId,
      table.createdAt,
    ),
    check(
      "echo_comments_content_length",
      sql`char_length(${table.content}) BETWEEN 2 AND 200`,
    ),
  ],
);

export const echoCommentLikes = pgTable(
  "echo_comment_likes",
  {
    commentId: uuid("comment_id")
      .notNull()
      .references(() => echoComments.id, { onDelete: "cascade" }),
    reviewerUserId: uuid("reviewer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "echo_comment_likes_pk",
      columns: [table.commentId, table.reviewerUserId],
    }),
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

export const feedbackDigestRuns = pgTable(
  "feedback_digest_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cutoffAt: timestamp("cutoff_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    messageId: text("message_id").notNull(),
    status: feedbackDigestStatusEnum("status")
      .notNull()
      .default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    sentAt: timestamp("sent_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastErrorCode: text("last_error_code"),
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
    uniqueIndex("feedback_digest_runs_cutoff_uidx").on(table.cutoffAt),
    uniqueIndex("feedback_digest_runs_message_id_uidx").on(table.messageId),
    index("feedback_digest_runs_due_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
    check(
      "feedback_digest_runs_attempt_nonnegative",
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      "feedback_digest_runs_lease_consistent",
      sql`(${table.status} = 'sending' AND ${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL) OR (${table.status} <> 'sending' AND ${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL)`,
    ),
    check(
      "feedback_digest_runs_sent_consistent",
      sql`(${table.status} = 'sent' AND ${table.sentAt} IS NOT NULL) OR (${table.status} <> 'sent' AND ${table.sentAt} IS NULL)`,
    ),
  ],
);

export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    category: feedbackCategoryEnum("category").notNull(),
    title: text("title").notNull(),
    details: text("details").notNull(),
    deliveryStatus: feedbackDeliveryStatusEnum("delivery_status")
      .notNull()
      .default("pending"),
    deliveredAt: timestamp("delivered_at", {
      withTimezone: true,
      mode: "date",
    }),
    digestRunId: uuid("digest_run_id").references(
      () => feedbackDigestRuns.id,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("feedback_user_created_idx").on(table.userId, table.createdAt),
    index("feedback_delivery_created_idx").on(
      table.deliveryStatus,
      table.createdAt,
    ),
    index("feedback_digest_run_idx").on(table.digestRunId),
    check(
      "feedback_title_length",
      sql`char_length(${table.title}) BETWEEN 2 AND 80`,
    ),
    check(
      "feedback_details_length",
      sql`char_length(${table.details}) BETWEEN 10 AND 2000`,
    ),
    check(
      "feedback_delivery_consistent",
      sql`(${table.deliveryStatus} = 'sent' AND ${table.deliveredAt} IS NOT NULL) OR (${table.deliveryStatus} <> 'sent' AND ${table.deliveredAt} IS NULL)`,
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
export type GameTimelineEventRow = typeof gameTimelineEvents.$inferSelect;
export type NewGameTimelineEventRow = typeof gameTimelineEvents.$inferInsert;
export type EchoArchiveRow = typeof echoArchives.$inferSelect;
export type EchoConsentRow = typeof echoConsents.$inferSelect;
export type EchoArchiveSourceRow = typeof echoArchiveSources.$inferSelect;
export type EchoArchiveEventRow = typeof echoArchiveEvents.$inferSelect;
export type EchoAssignmentRow = typeof echoAssignments.$inferSelect;
export type EchoJudgmentRow = typeof echoJudgments.$inferSelect;
export type EchoReviewerStatsRow = typeof echoReviewerStats.$inferSelect;
export type ReportRow = typeof reports.$inferSelect;
export type NewReportRow = typeof reports.$inferInsert;
export type ModerationEventRow = typeof moderationEvents.$inferSelect;
export type NewModerationEventRow = typeof moderationEvents.$inferInsert;
export type BanRow = typeof bans.$inferSelect;
export type NewBanRow = typeof bans.$inferInsert;
export type FeedbackRow = typeof feedback.$inferSelect;
export type NewFeedbackRow = typeof feedback.$inferInsert;
export type FeedbackDigestRunRow = typeof feedbackDigestRuns.$inferSelect;
export type NewFeedbackDigestRunRow = typeof feedbackDigestRuns.$inferInsert;
