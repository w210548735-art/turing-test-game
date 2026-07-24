CREATE TYPE "public"."feedback_digest_status" AS ENUM('pending', 'sending', 'sent', 'failed');
--> statement-breakpoint
CREATE TABLE "feedback_digest_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "cutoff_at" timestamp with time zone NOT NULL,
  "message_id" text NOT NULL,
  "status" "feedback_digest_status" DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "sent_at" timestamp with time zone,
  "last_error_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "feedback_digest_runs_attempt_nonnegative" CHECK ("feedback_digest_runs"."attempt_count" >= 0),
  CONSTRAINT "feedback_digest_runs_lease_consistent" CHECK (("feedback_digest_runs"."status" = 'sending' AND "feedback_digest_runs"."lease_owner" IS NOT NULL AND "feedback_digest_runs"."lease_expires_at" IS NOT NULL) OR ("feedback_digest_runs"."status" <> 'sending' AND "feedback_digest_runs"."lease_owner" IS NULL AND "feedback_digest_runs"."lease_expires_at" IS NULL)),
  CONSTRAINT "feedback_digest_runs_sent_consistent" CHECK (("feedback_digest_runs"."status" = 'sent' AND "feedback_digest_runs"."sent_at" IS NOT NULL) OR ("feedback_digest_runs"."status" <> 'sent' AND "feedback_digest_runs"."sent_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_digest_runs_cutoff_uidx"
  ON "feedback_digest_runs" USING btree ("cutoff_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_digest_runs_message_id_uidx"
  ON "feedback_digest_runs" USING btree ("message_id");
--> statement-breakpoint
CREATE INDEX "feedback_digest_runs_due_idx"
  ON "feedback_digest_runs" USING btree ("status", "next_attempt_at");
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "digest_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "feedback"
  ADD CONSTRAINT "feedback_digest_run_id_feedback_digest_runs_id_fk"
  FOREIGN KEY ("digest_run_id") REFERENCES "public"."feedback_digest_runs"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "feedback_digest_run_idx"
  ON "feedback" USING btree ("digest_run_id");
