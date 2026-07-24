-- 首版封闭 Alpha 持久化结构
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'deleted');
--> statement-breakpoint
CREATE TYPE "public"."game_status" AS ENUM('matching', 'active', 'settled', 'cancelled');
--> statement-breakpoint
CREATE TYPE "public"."identity_type" AS ENUM('human', 'ai');
--> statement-breakpoint
CREATE TYPE "public"."settlement_reason" AS ENUM('all_guessed', 'player_guessed', 'timeout', 'disconnect', 'cancelled');
--> statement-breakpoint
CREATE TYPE "public"."settlement_outcome" AS ENUM('won', 'lost', 'draw', 'cancelled');
--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('pending', 'reviewing', 'resolved', 'dismissed');
--> statement-breakpoint
CREATE TYPE "public"."moderation_decision" AS ENUM('allow', 'replace', 'block', 'terminate');
--> statement-breakpoint
CREATE TYPE "public"."ban_scope" AS ENUM('user', 'session', 'device', 'ip');
--> statement-breakpoint

CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_token_hash" text NOT NULL,
  "nickname" text NOT NULL,
  "typing_status" text NOT NULL,
  "status" "user_status" DEFAULT 'active' NOT NULL,
  "score" integer DEFAULT 0 NOT NULL,
  "games_played" integer DEFAULT 0 NOT NULL,
  "correct_guesses" integer DEFAULT 0 NOT NULL,
  "current_streak" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "users_games_played_nonnegative" CHECK ("users"."games_played" >= 0),
  CONSTRAINT "users_correct_guesses_nonnegative" CHECK ("users"."correct_guesses" >= 0)
);
--> statement-breakpoint
CREATE TABLE "games" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "status" "game_status" DEFAULT 'matching' NOT NULL,
  "match_type" "identity_type" NOT NULL,
  "ruleset_version" text NOT NULL,
  "ai_model" text,
  "ai_profile_version" text,
  "started_at" timestamp with time zone,
  "ends_at" timestamp with time zone,
  "settled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "games_ai_metadata_consistent" CHECK (
    ("games"."match_type" = 'ai' AND "games"."ai_model" IS NOT NULL AND "games"."ai_profile_version" IS NOT NULL)
    OR
    ("games"."match_type" = 'human' AND "games"."ai_model" IS NULL AND "games"."ai_profile_version" IS NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "game_participants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "game_id" uuid NOT NULL,
  "user_id" uuid,
  "identity_type" "identity_type" NOT NULL,
  "seat" integer NOT NULL,
  "joined_queue_at" timestamp with time zone NOT NULL,
  "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
  "disconnected_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "game_participants_seat_valid" CHECK ("game_participants"."seat" BETWEEN 0 AND 1),
  CONSTRAINT "game_participants_identity_user_consistent" CHECK (
    ("game_participants"."identity_type" = 'human' AND "game_participants"."user_id" IS NOT NULL)
    OR
    ("game_participants"."identity_type" = 'ai' AND "game_participants"."user_id" IS NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "game_id" uuid NOT NULL,
  "sender_participant_id" uuid,
  "sender_type" "identity_type" NOT NULL,
  "content" text NOT NULL,
  "client_message_id" text,
  "server_sequence" integer NOT NULL,
  "moderated" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "messages_server_sequence_positive" CHECK ("messages"."server_sequence" > 0),
  CONSTRAINT "messages_sender_consistent" CHECK (
    ("messages"."sender_type" = 'human' AND "messages"."sender_participant_id" IS NOT NULL)
    OR
    ("messages"."sender_type" = 'ai')
  )
);
--> statement-breakpoint
CREATE TABLE "guesses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "game_id" uuid NOT NULL,
  "participant_id" uuid NOT NULL,
  "target_guess" "identity_type" NOT NULL,
  "submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlements" (
  "settlement_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "game_id" uuid NOT NULL,
  "participant_id" uuid NOT NULL,
  "reason" "settlement_reason" NOT NULL,
  "opponent_type" "identity_type" NOT NULL,
  "player_guess" "identity_type",
  "correct" boolean,
  "outcome" "settlement_outcome" NOT NULL,
  "score_delta" integer DEFAULT 0 NOT NULL,
  "duration_ms" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "settlements_duration_nonnegative" CHECK ("settlements"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "game_id" uuid NOT NULL,
  "reporter_user_id" uuid,
  "reported_participant_id" uuid,
  "reason" text NOT NULL,
  "evidence" jsonb NOT NULL,
  "status" "report_status" DEFAULT 'pending' NOT NULL,
  "reviewer_note" text,
  "reviewed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "game_id" uuid,
  "message_id" uuid,
  "user_id" uuid,
  "source" text NOT NULL,
  "category" text NOT NULL,
  "decision" "moderation_decision" NOT NULL,
  "risk_score" integer DEFAULT 0 NOT NULL,
  "content_hash" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "moderation_events_risk_score_range" CHECK ("moderation_events"."risk_score" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "bans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scope" "ban_scope" NOT NULL,
  "identity_hash" text NOT NULL,
  "reason" text NOT NULL,
  "report_id" uuid,
  "created_by" text NOT NULL,
  "expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bans_revocation_consistent" CHECK ("bans"."revoked_at" IS NULL OR "bans"."revoked_by" IS NOT NULL)
);
--> statement-breakpoint

ALTER TABLE "game_participants"
  ADD CONSTRAINT "game_participants_game_id_games_id_fk"
  FOREIGN KEY ("game_id") REFERENCES "public"."games"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "game_participants"
  ADD CONSTRAINT "game_participants_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_game_id_games_id_fk"
  FOREIGN KEY ("game_id") REFERENCES "public"."games"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_sender_participant_id_game_participants_id_fk"
  FOREIGN KEY ("sender_participant_id") REFERENCES "public"."game_participants"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "guesses"
  ADD CONSTRAINT "guesses_game_id_games_id_fk"
  FOREIGN KEY ("game_id") REFERENCES "public"."games"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "guesses"
  ADD CONSTRAINT "guesses_participant_id_game_participants_id_fk"
  FOREIGN KEY ("participant_id") REFERENCES "public"."game_participants"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settlements"
  ADD CONSTRAINT "settlements_game_id_games_id_fk"
  FOREIGN KEY ("game_id") REFERENCES "public"."games"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settlements"
  ADD CONSTRAINT "settlements_participant_id_game_participants_id_fk"
  FOREIGN KEY ("participant_id") REFERENCES "public"."game_participants"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reports"
  ADD CONSTRAINT "reports_game_id_games_id_fk"
  FOREIGN KEY ("game_id") REFERENCES "public"."games"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reports"
  ADD CONSTRAINT "reports_reporter_user_id_users_id_fk"
  FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reports"
  ADD CONSTRAINT "reports_reported_participant_id_game_participants_id_fk"
  FOREIGN KEY ("reported_participant_id") REFERENCES "public"."game_participants"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "moderation_events"
  ADD CONSTRAINT "moderation_events_game_id_games_id_fk"
  FOREIGN KEY ("game_id") REFERENCES "public"."games"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "moderation_events"
  ADD CONSTRAINT "moderation_events_message_id_messages_id_fk"
  FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "moderation_events"
  ADD CONSTRAINT "moderation_events_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bans"
  ADD CONSTRAINT "bans_report_id_reports_id_fk"
  FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX "users_session_token_hash_uidx" ON "users" USING btree ("session_token_hash");
--> statement-breakpoint
CREATE INDEX "users_status_last_seen_idx" ON "users" USING btree ("status", "last_seen_at");
--> statement-breakpoint
CREATE INDEX "games_status_created_idx" ON "games" USING btree ("status", "created_at");
--> statement-breakpoint
CREATE INDEX "games_match_type_created_idx" ON "games" USING btree ("match_type", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "game_participants_game_seat_uidx" ON "game_participants" USING btree ("game_id", "seat");
--> statement-breakpoint
CREATE UNIQUE INDEX "game_participants_game_user_uidx" ON "game_participants" USING btree ("game_id", "user_id");
--> statement-breakpoint
CREATE INDEX "game_participants_user_created_idx" ON "game_participants" USING btree ("user_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "messages_game_sequence_uidx" ON "messages" USING btree ("game_id", "server_sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "messages_game_client_message_uidx" ON "messages" USING btree ("game_id", "client_message_id");
--> statement-breakpoint
CREATE INDEX "messages_game_created_idx" ON "messages" USING btree ("game_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "guesses_game_participant_uidx" ON "guesses" USING btree ("game_id", "participant_id");
--> statement-breakpoint
CREATE INDEX "guesses_game_submitted_idx" ON "guesses" USING btree ("game_id", "submitted_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_game_participant_uidx" ON "settlements" USING btree ("game_id", "participant_id");
--> statement-breakpoint
CREATE INDEX "settlements_game_created_idx" ON "settlements" USING btree ("game_id", "created_at");
--> statement-breakpoint
CREATE INDEX "reports_status_created_idx" ON "reports" USING btree ("status", "created_at");
--> statement-breakpoint
CREATE INDEX "reports_game_idx" ON "reports" USING btree ("game_id");
--> statement-breakpoint
CREATE INDEX "reports_reporter_created_idx" ON "reports" USING btree ("reporter_user_id", "created_at");
--> statement-breakpoint
CREATE INDEX "moderation_events_decision_created_idx" ON "moderation_events" USING btree ("decision", "created_at");
--> statement-breakpoint
CREATE INDEX "moderation_events_user_created_idx" ON "moderation_events" USING btree ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX "moderation_events_game_idx" ON "moderation_events" USING btree ("game_id");
--> statement-breakpoint
CREATE INDEX "bans_identity_lookup_idx" ON "bans" USING btree ("scope", "identity_hash", "expires_at");
--> statement-breakpoint
CREATE INDEX "bans_created_idx" ON "bans" USING btree ("created_at");
