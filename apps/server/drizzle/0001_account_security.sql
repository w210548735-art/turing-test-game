-- P0 账户、登录与安全审计结构；仅追加对象，兼容既有游客用户
ALTER TYPE "public"."user_status" ADD VALUE IF NOT EXISTS 'pending_email' BEFORE 'active';
--> statement-breakpoint
ALTER TYPE "public"."user_status" ADD VALUE IF NOT EXISTS 'limited' AFTER 'active';
--> statement-breakpoint
ALTER TYPE "public"."user_status" ADD VALUE IF NOT EXISTS 'banned' BEFORE 'deleted';
--> statement-breakpoint
CREATE TYPE "public"."verification_token_purpose" AS ENUM('verify_email', 'reset_password', 'change_email');
--> statement-breakpoint
CREATE TYPE "public"."security_event_severity" AS ENUM('info', 'warning', 'critical');
--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN "email_original" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_canonical" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_login_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_canonical_normalized"
  CHECK ("users"."email_canonical" IS NULL OR "users"."email_canonical" = lower(btrim("users"."email_canonical")));
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_canonical_uidx" ON "users" USING btree ("email_canonical");
--> statement-breakpoint

CREATE TABLE "devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "token_hash" text NOT NULL,
  "label" text,
  "user_agent_hash" text,
  "ip_hash" text,
  "trusted_at" timestamp with time zone,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "device_id" uuid,
  "token_hash" text NOT NULL,
  "csrf_token_hash" text NOT NULL,
  "ip_hash" text,
  "user_agent_hash" text,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "idle_expires_at" timestamp with time zone NOT NULL,
  "absolute_expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sessions_expiry_order" CHECK ("sessions"."idle_expires_at" <= "sessions"."absolute_expires_at")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "purpose" "verification_token_purpose" NOT NULL,
  "token_hash" text NOT NULL,
  "target_email_canonical" text,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "verification_tokens_target_email_normalized"
    CHECK ("verification_tokens"."target_email_canonical" IS NULL OR "verification_tokens"."target_email_canonical" = lower(btrim("verification_tokens"."target_email_canonical")))
);
--> statement-breakpoint
CREATE TABLE "security_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "session_id" uuid,
  "device_id" uuid,
  "event_type" text NOT NULL,
  "severity" "security_event_severity" DEFAULT 'info' NOT NULL,
  "ip_hash" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "devices"
  ADD CONSTRAINT "devices_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_device_id_devices_id_fk"
  FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "verification_tokens"
  ADD CONSTRAINT "verification_tokens_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "security_events"
  ADD CONSTRAINT "security_events_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "security_events"
  ADD CONSTRAINT "security_events_session_id_sessions_id_fk"
  FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "security_events"
  ADD CONSTRAINT "security_events_device_id_devices_id_fk"
  FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX "devices_token_hash_uidx" ON "devices" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "devices_user_last_seen_idx" ON "devices" USING btree ("user_id", "last_seen_at");
--> statement-breakpoint
CREATE INDEX "devices_user_revoked_idx" ON "devices" USING btree ("user_id", "revoked_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uidx" ON "sessions" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "sessions_user_active_idx" ON "sessions" USING btree ("user_id", "revoked_at", "absolute_expires_at");
--> statement-breakpoint
CREATE INDEX "sessions_device_last_seen_idx" ON "sessions" USING btree ("device_id", "last_seen_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_tokens_token_hash_uidx" ON "verification_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "verification_tokens_user_purpose_idx" ON "verification_tokens" USING btree ("user_id", "purpose", "created_at");
--> statement-breakpoint
CREATE INDEX "verification_tokens_expiry_idx" ON "verification_tokens" USING btree ("expires_at", "used_at", "revoked_at");
--> statement-breakpoint
CREATE INDEX "security_events_user_created_idx" ON "security_events" USING btree ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX "security_events_type_created_idx" ON "security_events" USING btree ("event_type", "created_at");
--> statement-breakpoint
CREATE INDEX "security_events_session_idx" ON "security_events" USING btree ("session_id");
