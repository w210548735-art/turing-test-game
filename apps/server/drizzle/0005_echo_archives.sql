CREATE TYPE "public"."game_timeline_event_type" AS ENUM(
  'room_started',
  'typing_start',
  'typing_stop',
  'message_received',
  'message_visible'
);
--> statement-breakpoint
CREATE TYPE "public"."echo_archive_status" AS ENUM(
  'pending',
  'available',
  'rejected',
  'withdrawn'
);
--> statement-breakpoint
CREATE TYPE "public"."echo_consent_decision" AS ENUM('approve', 'decline');
--> statement-breakpoint
CREATE TYPE "public"."echo_identity_pattern" AS ENUM(
  'human_human',
  'human_ai',
  'ai_ai'
);
--> statement-breakpoint

CREATE TABLE "game_timeline_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "game_id" uuid NOT NULL,
  "event_sequence" integer NOT NULL,
  "event_type" "game_timeline_event_type" NOT NULL,
  "actor_participant_id" uuid,
  "message_id" uuid,
  "occurred_at" timestamp with time zone NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  CONSTRAINT "game_timeline_events_sequence_positive"
    CHECK ("event_sequence" > 0)
);
--> statement-breakpoint

CREATE TABLE "echo_archives" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_game_id" uuid,
  "status" "echo_archive_status" DEFAULT 'pending' NOT NULL,
  "identity_pattern" "echo_identity_pattern" NOT NULL,
  "timeline_version" text DEFAULT 'echo-v1' NOT NULL,
  "duration_ms" integer NOT NULL,
  "consent_expires_at" timestamp with time zone NOT NULL,
  "published_at" timestamp with time zone,
  "withdrawn_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "echo_archives_duration_nonnegative"
    CHECK ("duration_ms" >= 0)
);
--> statement-breakpoint

CREATE TABLE "echo_consents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "game_id" uuid NOT NULL,
  "participant_id" uuid NOT NULL,
  "decision" "echo_consent_decision" NOT NULL,
  "client_request_id" uuid NOT NULL,
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "echo_archive_sources" (
  "archive_id" uuid NOT NULL,
  "public_seat" integer NOT NULL,
  "source_participant_id" uuid,
  "source_user_id" uuid,
  "identity_type" "identity_type" NOT NULL,
  CONSTRAINT "echo_archive_sources_pk"
    PRIMARY KEY("archive_id", "public_seat"),
  CONSTRAINT "echo_archive_sources_seat_valid"
    CHECK ("public_seat" BETWEEN 0 AND 1)
);
--> statement-breakpoint

CREATE TABLE "echo_archive_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "archive_id" uuid NOT NULL,
  "event_sequence" integer NOT NULL,
  "event_type" "game_timeline_event_type" NOT NULL,
  "public_seat" integer NOT NULL,
  "offset_ms" integer NOT NULL,
  "content" text,
  "moderated" boolean DEFAULT false NOT NULL,
  CONSTRAINT "echo_archive_events_seat_valid"
    CHECK ("public_seat" BETWEEN 0 AND 1),
  CONSTRAINT "echo_archive_events_offset_nonnegative"
    CHECK ("offset_ms" >= 0)
);
--> statement-breakpoint

CREATE TABLE "echo_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "archive_id" uuid NOT NULL,
  "reviewer_user_id" uuid NOT NULL,
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint

CREATE TABLE "echo_judgments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "assignment_id" uuid NOT NULL,
  "archive_id" uuid NOT NULL,
  "reviewer_user_id" uuid NOT NULL,
  "guess_a" "identity_type" NOT NULL,
  "confidence_a" integer NOT NULL,
  "guess_b" "identity_type" NOT NULL,
  "confidence_b" integer NOT NULL,
  "correct_count" integer NOT NULL,
  "both_correct" boolean NOT NULL,
  "score_delta" integer NOT NULL,
  "confidence_calibration" integer NOT NULL,
  "client_request_id" uuid NOT NULL,
  "submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "echo_judgments_confidence_range"
    CHECK ("confidence_a" BETWEEN 0 AND 100 AND "confidence_b" BETWEEN 0 AND 100),
  CONSTRAINT "echo_judgments_correct_count_range"
    CHECK ("correct_count" BETWEEN 0 AND 2),
  CONSTRAINT "echo_judgments_calibration_range"
    CHECK ("confidence_calibration" BETWEEN 0 AND 100)
);
--> statement-breakpoint

CREATE TABLE "echo_reviewer_stats" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "reviews_played" integer DEFAULT 0 NOT NULL,
  "identities_correct" integer DEFAULT 0 NOT NULL,
  "perfect_judgments" integer DEFAULT 0 NOT NULL,
  "score" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "game_timeline_events"
  ADD CONSTRAINT "game_timeline_events_game_id_games_id_fk"
  FOREIGN KEY ("game_id") REFERENCES "public"."games"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "game_timeline_events"
  ADD CONSTRAINT "game_timeline_events_actor_participant_id_game_participants_id_fk"
  FOREIGN KEY ("actor_participant_id") REFERENCES "public"."game_participants"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "game_timeline_events"
  ADD CONSTRAINT "game_timeline_events_message_id_messages_id_fk"
  FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "echo_archives"
  ADD CONSTRAINT "echo_archives_source_game_id_games_id_fk"
  FOREIGN KEY ("source_game_id") REFERENCES "public"."games"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "echo_consents"
  ADD CONSTRAINT "echo_consents_game_id_games_id_fk"
  FOREIGN KEY ("game_id") REFERENCES "public"."games"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "echo_consents"
  ADD CONSTRAINT "echo_consents_participant_id_game_participants_id_fk"
  FOREIGN KEY ("participant_id") REFERENCES "public"."game_participants"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "echo_archive_sources"
  ADD CONSTRAINT "echo_archive_sources_archive_id_echo_archives_id_fk"
  FOREIGN KEY ("archive_id") REFERENCES "public"."echo_archives"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "echo_archive_sources"
  ADD CONSTRAINT "echo_archive_sources_source_participant_id_game_participants_id_fk"
  FOREIGN KEY ("source_participant_id") REFERENCES "public"."game_participants"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "echo_archive_sources"
  ADD CONSTRAINT "echo_archive_sources_source_user_id_users_id_fk"
  FOREIGN KEY ("source_user_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "echo_archive_events"
  ADD CONSTRAINT "echo_archive_events_archive_id_echo_archives_id_fk"
  FOREIGN KEY ("archive_id") REFERENCES "public"."echo_archives"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "echo_assignments"
  ADD CONSTRAINT "echo_assignments_archive_id_echo_archives_id_fk"
  FOREIGN KEY ("archive_id") REFERENCES "public"."echo_archives"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "echo_assignments"
  ADD CONSTRAINT "echo_assignments_reviewer_user_id_users_id_fk"
  FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "echo_judgments"
  ADD CONSTRAINT "echo_judgments_assignment_id_echo_assignments_id_fk"
  FOREIGN KEY ("assignment_id") REFERENCES "public"."echo_assignments"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "echo_judgments"
  ADD CONSTRAINT "echo_judgments_archive_id_echo_archives_id_fk"
  FOREIGN KEY ("archive_id") REFERENCES "public"."echo_archives"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "echo_judgments"
  ADD CONSTRAINT "echo_judgments_reviewer_user_id_users_id_fk"
  FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "echo_reviewer_stats"
  ADD CONSTRAINT "echo_reviewer_stats_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX "game_timeline_events_game_sequence_uidx"
  ON "game_timeline_events" USING btree ("game_id", "event_sequence");
--> statement-breakpoint
CREATE INDEX "game_timeline_events_game_time_idx"
  ON "game_timeline_events" USING btree ("game_id", "occurred_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "echo_archives_source_game_uidx"
  ON "echo_archives" USING btree ("source_game_id");
--> statement-breakpoint
CREATE INDEX "echo_archives_status_published_idx"
  ON "echo_archives" USING btree ("status", "published_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "echo_consents_game_participant_uidx"
  ON "echo_consents" USING btree ("game_id", "participant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "echo_consents_client_request_uidx"
  ON "echo_consents" USING btree ("client_request_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "echo_archive_sources_participant_uidx"
  ON "echo_archive_sources" USING btree ("archive_id", "source_participant_id");
--> statement-breakpoint
CREATE INDEX "echo_archive_sources_user_idx"
  ON "echo_archive_sources" USING btree ("source_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "echo_archive_events_archive_sequence_uidx"
  ON "echo_archive_events" USING btree ("archive_id", "event_sequence");
--> statement-breakpoint
CREATE INDEX "echo_archive_events_archive_offset_idx"
  ON "echo_archive_events" USING btree ("archive_id", "offset_ms");
--> statement-breakpoint
CREATE UNIQUE INDEX "echo_assignments_archive_reviewer_uidx"
  ON "echo_assignments" USING btree ("archive_id", "reviewer_user_id");
--> statement-breakpoint
CREATE INDEX "echo_assignments_reviewer_expiry_idx"
  ON "echo_assignments" USING btree ("reviewer_user_id", "expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "echo_judgments_assignment_uidx"
  ON "echo_judgments" USING btree ("assignment_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "echo_judgments_client_request_uidx"
  ON "echo_judgments" USING btree ("client_request_id");
--> statement-breakpoint
CREATE INDEX "echo_judgments_reviewer_submitted_idx"
  ON "echo_judgments" USING btree ("reviewer_user_id", "submitted_at");
