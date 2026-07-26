import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import { createDatabase } from "../src/db/client.js";
import {
  bans,
  deviceAccounts,
  devices,
  echoArchiveEvents,
  echoArchives,
  echoArchiveSources,
  echoAssignments,
  echoCommentAuthors,
  echoCommentLikes,
  echoComments,
  echoConsents,
  echoIdentityPatternEnum,
  echoJudgments,
  echoReviewerStats,
  feedback,
  feedbackCategoryEnum,
  feedbackDigestRuns,
  feedbackDigestStatusEnum,
  feedbackDeliveryStatusEnum,
  gameParticipants,
  gameTimelineEvents,
  games,
  guesses,
  messages,
  moderationEvents,
  reports,
  securityEvents,
  sessions,
  settlements,
  userStatusEnum,
  users,
  verificationTokens,
  verificationTokenPurposeEnum,
} from "../src/db/schema.js";

const allTables = [
  users,
  devices,
  deviceAccounts,
  sessions,
  verificationTokens,
  securityEvents,
  games,
  gameParticipants,
  messages,
  guesses,
  settlements,
  reports,
  moderationEvents,
  bans,
  feedback,
  feedbackDigestRuns,
  gameTimelineEvents,
  echoArchives,
  echoConsents,
  echoArchiveSources,
  echoArchiveEvents,
  echoAssignments,
  echoJudgments,
  echoReviewerStats,
  echoCommentAuthors,
  echoComments,
  echoCommentLikes,
];

describe("数据库结构", () => {
  it("包含封闭 Alpha、账户安全与反馈闭环所需的数据表", () => {
    assert.deepEqual(
      allTables.map((table) => getTableName(table)),
      [
        "users",
        "devices",
        "device_accounts",
        "sessions",
        "verification_tokens",
        "security_events",
        "games",
        "game_participants",
        "messages",
        "guesses",
        "settlements",
        "reports",
        "moderation_events",
        "bans",
        "feedback",
        "feedback_digest_runs",
        "game_timeline_events",
        "echo_archives",
        "echo_consents",
        "echo_archive_sources",
        "echo_archive_events",
        "echo_assignments",
        "echo_judgments",
        "echo_reviewer_stats",
        "echo_comment_authors",
        "echo_comments",
        "echo_comment_likes",
      ],
    );
  });

  it("回声批注迁移保留匿名作者并让评论和点赞随档案删除", async () => {
    const migrationUrl = new URL(
      "../drizzle/0006_echo_comments.sql",
      import.meta.url,
    );
    const migration = await readFile(migrationUrl, "utf8");
    for (const table of [
      "echo_comment_authors",
      "echo_comments",
      "echo_comment_likes",
    ]) {
      assert.match(migration, new RegExp(`CREATE TABLE "${table}"`));
    }
    assert.match(
      migration,
      /echo_comment_authors_reviewer_user_id_users_id_fk[\s\S]*ON DELETE set null/,
    );
    assert.match(
      migration,
      /echo_comments_author_assignment_id_echo_assignments_id_fk[\s\S]*ON DELETE set null/,
    );
    assert.match(migration, /echo_comments_content_length/);
    assert.match(migration, /echo_comment_likes_pk/);
    assert.doesNotMatch(migration, /source_game_id|source_user_id/);
  });

  it("回声档案迁移物化匿名时间轴并允许原始游戏按期删除", async () => {
    assert.deepEqual(echoIdentityPatternEnum.enumValues, [
      "human_human",
      "human_ai",
      "ai_ai",
    ]);
    const archiveColumns = getTableColumns(echoArchives);
    assert.equal(archiveColumns.sourceGameId.notNull, false);
    const migrationUrl = new URL(
      "../drizzle/0005_echo_archives.sql",
      import.meta.url,
    );
    const migration = await readFile(migrationUrl, "utf8");
    for (const table of [
      "game_timeline_events",
      "echo_archives",
      "echo_consents",
      "echo_archive_sources",
      "echo_archive_events",
      "echo_assignments",
      "echo_judgments",
      "echo_reviewer_stats",
    ]) {
      assert.match(migration, new RegExp(`CREATE TABLE "${table}"`));
    }
    assert.match(
      migration,
      /echo_archives_source_game_id_games_id_fk[\s\S]*ON DELETE set null/,
    );
    assert.match(migration, /echo_judgments_calibration_range/);
    assert.match(migration, /'ai_ai'/);
    assert.doesNotMatch(
      migration,
      /"source_game_id" uuid NOT NULL/,
    );
  });

  it("反馈表使用受限分类、投递状态与长度约束迁移", async () => {
    assert.deepEqual(feedbackCategoryEnum.enumValues, [
      "bug",
      "suggestion",
      "other",
    ]);
    assert.deepEqual(feedbackDeliveryStatusEnum.enumValues, [
      "pending",
      "sent",
      "failed",
    ]);
    assert.deepEqual(feedbackDigestStatusEnum.enumValues, [
      "pending",
      "sending",
      "sent",
      "failed",
    ]);
    const columns = getTableColumns(feedback);
    assert.equal(columns.userId.name, "user_id");
    assert.equal(columns.deliveryStatus.name, "delivery_status");
    assert.equal(columns.deliveredAt.name, "delivered_at");

    const migrationUrl = new URL(
      "../drizzle/0003_feedback.sql",
      import.meta.url,
    );
    const migration = await readFile(migrationUrl, "utf8");
    assert.match(migration, /CREATE TABLE "feedback"/);
    assert.match(migration, /feedback_title_length/);
    assert.match(migration, /feedback_details_length/);
    assert.match(migration, /ON DELETE set null/);
    assert.doesNotMatch(migration, /DROP (?:TABLE|COLUMN|TYPE|INDEX)/i);

    const digestMigrationUrl = new URL(
      "../drizzle/0004_feedback_digest.sql",
      import.meta.url,
    );
    const digestMigration = await readFile(digestMigrationUrl, "utf8");
    assert.match(
      digestMigration,
      /CREATE TABLE "feedback_digest_runs"/,
    );
    assert.match(
      digestMigration,
      /feedback_digest_runs_lease_consistent/,
    );
    assert.match(
      digestMigration,
      /feedback_digest_runs_message_id_uidx/,
    );
    assert.match(digestMigration, /ADD COLUMN "digest_run_id"/);
    assert.doesNotMatch(
      digestMigration,
      /DROP (?:TABLE|COLUMN|TYPE|INDEX)/i,
    );

    const journalUrl = new URL(
      "../drizzle/meta/_journal.json",
      import.meta.url,
    );
    const journal = await readFile(journalUrl, "utf8");
    assert.match(journal, /"tag": "0004_feedback_digest"/);
  });

  it("账户字段兼容游客数据并使用规范化邮箱唯一索引", () => {
    const userColumns = getTableColumns(users);
    assert.equal(userColumns.emailOriginal.name, "email_original");
    assert.equal(userColumns.emailOriginal.notNull, false);
    assert.equal(userColumns.emailCanonical.name, "email_canonical");
    assert.equal(userColumns.emailCanonical.notNull, false);
    assert.equal(userColumns.passwordHash.name, "password_hash");
    assert.equal(userColumns.passwordHash.notNull, false);
    assert.equal(userColumns.emailVerifiedAt.name, "email_verified_at");
    assert.equal(userColumns.emailVerifiedAt.notNull, false);
    assert.equal(userColumns.lastLoginAt.name, "last_login_at");
    assert.equal(userColumns.lastLoginAt.notNull, false);
    assert.equal(userColumns.deletedAt.name, "deleted_at");
    assert.equal(userColumns.deletedAt.notNull, false);
    assert.equal(userColumns.sessionTokenHash.notNull, false);
    assert.equal(userColumns.updatedAt.name, "updated_at");

    assert.deepEqual(userStatusEnum.enumValues, [
      "pending_email",
      "active",
      "limited",
      "suspended",
      "banned",
      "deleted",
    ]);
    assert.deepEqual(verificationTokenPurposeEnum.enumValues, [
      "verify_email",
      "reset_password",
      "change_email",
      "websocket_ticket",
    ]);
  });

  it("会话、设备和验证令牌只保存哈希并具备生命周期字段", () => {
    const sessionColumns = getTableColumns(sessions);
    assert.equal(sessionColumns.tokenHash.name, "token_hash");
    assert.equal(sessionColumns.csrfTokenHash.name, "csrf_token_hash");
    assert.equal(sessionColumns.idleExpiresAt.name, "idle_expires_at");
    assert.equal(sessionColumns.absoluteExpiresAt.name, "absolute_expires_at");
    assert.equal(sessionColumns.lastSeenAt.name, "last_seen_at");
    assert.equal(sessionColumns.revokedAt.name, "revoked_at");
    assert.equal("token" in sessionColumns, false);

    const deviceColumns = getTableColumns(devices);
    assert.equal(deviceColumns.tokenHash.name, "token_hash");
    assert.equal(deviceColumns.lastSeenAt.name, "last_seen_at");
    assert.equal(deviceColumns.revokedAt.name, "revoked_at");
    assert.equal(deviceColumns.riskScore.name, "risk_score");
    assert.equal("token" in deviceColumns, false);

    const verificationColumns = getTableColumns(verificationTokens);
    assert.equal(verificationColumns.tokenHash.name, "token_hash");
    assert.equal(verificationColumns.expiresAt.name, "expires_at");
    assert.equal(verificationColumns.usedAt.name, "used_at");
    assert.equal(verificationColumns.revokedAt.name, "revoked_at");
    assert.equal("token" in verificationColumns, false);

    const eventColumns = getTableColumns(securityEvents);
    assert.equal(eventColumns.eventType.name, "event_type");
    assert.equal(eventColumns.severity.name, "severity");
    assert.equal(eventColumns.ipHash.name, "ip_hash");
    assert.equal(eventColumns.metadata.name, "metadata");
  });

  it("包含规则版本、AI 版本和幂等字段", () => {
    const gameColumns = getTableColumns(games);
    assert.equal(gameColumns.rulesetVersion.name, "ruleset_version");
    assert.equal(gameColumns.aiModel.name, "ai_model");
    assert.equal(gameColumns.aiProfileVersion.name, "ai_profile_version");

    const messageColumns = getTableColumns(messages);
    assert.equal(messageColumns.clientMessageId.name, "client_message_id");
    assert.equal(messageColumns.serverSequence.name, "server_sequence");

    const settlementColumns = getTableColumns(settlements);
    assert.equal(settlementColumns.settlementId.name, "settlement_id");
    assert.equal(settlementColumns.settlementId.primary, true);
  });

  it("缺少 DATABASE_URL 时返回明确的 unavailable 状态", () => {
    const state = createDatabase({ databaseUrl: "  " });
    assert.deepEqual(state, {
      available: false,
      reason: "DATABASE_URL_MISSING",
      message: "未配置 DATABASE_URL，持久化功能不可用。",
    });
  });

  it("迁移为消息、判断和结算建立唯一约束", async () => {
    const migrationUrl = new URL(
      "../drizzle/0000_initial.sql",
      import.meta.url,
    );
    const sql = await readFile(migrationUrl, "utf8");

    for (const table of [
      "users",
      "games",
      "game_participants",
      "messages",
      "guesses",
      "settlements",
      "reports",
      "moderation_events",
      "bans",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE "${table}"`));
    }

    assert.match(sql, /messages_game_sequence_uidx/);
    assert.match(sql, /messages_game_client_message_uidx/);
    assert.match(sql, /guesses_game_participant_uidx/);
    assert.match(sql, /settlements_game_participant_uidx/);
    assert.match(sql, /bans_identity_lookup_idx/);
    assert.match(sql, /FOREIGN KEY \("game_id"\)/);
  });

  it("账户安全迁移保持向后兼容并建立唯一约束与查询索引", async () => {
    const migrationUrl = new URL(
      "../drizzle/0001_account_security.sql",
      import.meta.url,
    );
    const sql = await readFile(migrationUrl, "utf8");

    for (const table of [
      "devices",
      "sessions",
      "verification_tokens",
      "security_events",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE "${table}"`));
    }

    assert.match(
      sql,
      /ALTER TABLE "users" ADD COLUMN "email_original" text;/,
    );
    assert.match(
      sql,
      /ALTER TABLE "users" ADD COLUMN "email_canonical" text;/,
    );
    assert.match(
      sql,
      /ALTER TABLE "users" ADD COLUMN "password_hash" text;/,
    );
    assert.match(
      sql,
      /ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;/,
    );
    assert.match(
      sql,
      /ALTER TABLE "users" ADD COLUMN "last_login_at" timestamp with time zone;/,
    );
    assert.match(
      sql,
      /ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;/,
    );
    assert.doesNotMatch(sql, /DROP (?:TABLE|COLUMN|TYPE|INDEX)/i);
    assert.doesNotMatch(
      sql,
      /ADD COLUMN "(?:email_original|email_canonical|password_hash|email_verified_at|last_login_at|deleted_at)"[^;]*NOT NULL/i,
    );

    assert.match(sql, /users_email_canonical_uidx/);
    assert.match(sql, /devices_token_hash_uidx/);
    assert.match(sql, /sessions_token_hash_uidx/);
    assert.match(sql, /verification_tokens_token_hash_uidx/);
    assert.match(sql, /sessions_user_active_idx/);
    assert.match(sql, /verification_tokens_expiry_idx/);
    assert.match(sql, /security_events_type_created_idx/);
    assert.doesNotMatch(sql, /"token"\s+text/i);
  });

  it("认证运行时迁移允许账户行不带游客 Token 并建立设备多账号关系", async () => {
    const migrationUrl = new URL(
      "../drizzle/0002_auth_runtime.sql",
      import.meta.url,
    );
    const sql = await readFile(migrationUrl, "utf8");

    assert.match(
      sql,
      /ALTER COLUMN "session_token_hash" DROP NOT NULL/,
    );
    assert.match(sql, /ADD COLUMN "updated_at"/);
    assert.match(sql, /ADD COLUMN "risk_score"/);
    assert.match(sql, /ADD VALUE IF NOT EXISTS 'websocket_ticket'/);
    assert.match(sql, /CREATE TABLE "device_accounts"/);
    assert.match(sql, /device_accounts_device_user_pk/);
    assert.match(
      sql,
      /INSERT INTO "device_accounts" \("device_id", "user_id", "linked_at"\)/,
    );
    assert.match(sql, /device_accounts_user_linked_idx/);
    assert.doesNotMatch(sql, /DROP (?:TABLE|COLUMN|TYPE|INDEX)/i);
  });

  it("注册账户拥有独立玩家编号和全局名称，访客不会自动占号", async () => {
    const columns = getTableColumns(users);
    assert.equal(columns.playerNumber.name, "player_number");
    assert.equal(columns.playerNumber.notNull, false);
    assert.equal(columns.displayName.name, "display_name");
    assert.equal(columns.displayName.notNull, false);

    const migrationUrl = new URL(
      "../drizzle/0007_account_identity.sql",
      import.meta.url,
    );
    const sql = await readFile(migrationUrl, "utf8");
    assert.match(sql, /CREATE SEQUENCE "user_player_number_seq"/);
    assert.match(
      sql,
      /WHERE "email_canonical" IS NOT NULL AND "player_number" IS NULL/,
    );
    assert.match(sql, /users_player_number_uidx/);
    assert.doesNotMatch(
      sql,
      /ALTER COLUMN "player_number" SET DEFAULT/,
    );
  });

  it("账户角色默认 PLAYER，ROOT 提升迁移不硬编码任何邮箱", async () => {
    const columns = getTableColumns(users);
    assert.equal(columns.role.name, "role");
    assert.equal(columns.role.notNull, true);
    assert.equal(columns.role.default, "player");

    const migrationUrl = new URL(
      "../drizzle/0008_account_roles.sql",
      import.meta.url,
    );
    const sql = await readFile(migrationUrl, "utf8");
    assert.match(sql, /ENUM\('player', 'root'\)/);
    assert.match(sql, /ADD COLUMN "role"/);
    assert.match(sql, /users_role_status_idx/);
    assert.doesNotMatch(sql, /210548735|qq\.com/i);
    assert.doesNotMatch(sql, /DROP (?:TABLE|COLUMN|TYPE|INDEX)/i);
  });
});
