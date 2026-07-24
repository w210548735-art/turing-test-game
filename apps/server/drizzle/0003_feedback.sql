CREATE TYPE "public"."feedback_category" AS ENUM('bug', 'suggestion', 'other');
--> statement-breakpoint
CREATE TYPE "public"."feedback_delivery_status" AS ENUM('pending', 'sent', 'failed');
--> statement-breakpoint
CREATE TABLE "feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "category" "feedback_category" NOT NULL,
  "title" text NOT NULL,
  "details" text NOT NULL,
  "delivery_status" "feedback_delivery_status" DEFAULT 'pending' NOT NULL,
  "delivered_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "feedback_title_length" CHECK (char_length("feedback"."title") BETWEEN 2 AND 80),
  CONSTRAINT "feedback_details_length" CHECK (char_length("feedback"."details") BETWEEN 10 AND 2000),
  CONSTRAINT "feedback_delivery_consistent" CHECK (("feedback"."delivery_status" = 'sent' AND "feedback"."delivered_at" IS NOT NULL) OR ("feedback"."delivery_status" <> 'sent' AND "feedback"."delivered_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "feedback"
  ADD CONSTRAINT "feedback_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "feedback_user_created_idx"
  ON "feedback" USING btree ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX "feedback_delivery_created_idx"
  ON "feedback" USING btree ("delivery_status", "created_at");
