import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import { createDatabase } from "../src/db/client.js";
import {
  bans,
  deviceAccounts,
  devices,
  gameParticipants,
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
];

describe("数据库结构", () => {
  it("包含封闭 Alpha 与账户安全所需的十四张表", () => {
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
      ],
    );
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
});
