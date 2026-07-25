CREATE TABLE "echo_comment_authors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "archive_id" uuid NOT NULL,
  "reviewer_user_id" uuid,
  "alias" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "echo_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "archive_id" uuid NOT NULL,
  "archive_event_id" uuid NOT NULL,
  "author_id" uuid NOT NULL,
  "author_assignment_id" uuid,
  "content" text NOT NULL,
  "client_request_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "echo_comments_content_length"
    CHECK (char_length("content") BETWEEN 2 AND 200)
);
--> statement-breakpoint

CREATE TABLE "echo_comment_likes" (
  "comment_id" uuid NOT NULL,
  "reviewer_user_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "echo_comment_likes_pk"
    PRIMARY KEY("comment_id", "reviewer_user_id")
);
--> statement-breakpoint

ALTER TABLE "echo_comment_authors"
  ADD CONSTRAINT "echo_comment_authors_archive_id_echo_archives_id_fk"
  FOREIGN KEY ("archive_id") REFERENCES "public"."echo_archives"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "echo_comment_authors"
  ADD CONSTRAINT "echo_comment_authors_reviewer_user_id_users_id_fk"
  FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "echo_comments"
  ADD CONSTRAINT "echo_comments_archive_id_echo_archives_id_fk"
  FOREIGN KEY ("archive_id") REFERENCES "public"."echo_archives"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "echo_comments"
  ADD CONSTRAINT "echo_comments_archive_event_id_echo_archive_events_id_fk"
  FOREIGN KEY ("archive_event_id") REFERENCES "public"."echo_archive_events"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "echo_comments"
  ADD CONSTRAINT "echo_comments_author_id_echo_comment_authors_id_fk"
  FOREIGN KEY ("author_id") REFERENCES "public"."echo_comment_authors"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "echo_comments"
  ADD CONSTRAINT "echo_comments_author_assignment_id_echo_assignments_id_fk"
  FOREIGN KEY ("author_assignment_id") REFERENCES "public"."echo_assignments"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "echo_comment_likes"
  ADD CONSTRAINT "echo_comment_likes_comment_id_echo_comments_id_fk"
  FOREIGN KEY ("comment_id") REFERENCES "public"."echo_comments"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "echo_comment_likes"
  ADD CONSTRAINT "echo_comment_likes_reviewer_user_id_users_id_fk"
  FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX "echo_comment_authors_archive_reviewer_uidx"
  ON "echo_comment_authors" USING btree ("archive_id", "reviewer_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "echo_comment_authors_archive_alias_uidx"
  ON "echo_comment_authors" USING btree ("archive_id", "alias");
--> statement-breakpoint
CREATE UNIQUE INDEX "echo_comments_client_request_uidx"
  ON "echo_comments" USING btree ("client_request_id");
--> statement-breakpoint
CREATE INDEX "echo_comments_archive_event_created_idx"
  ON "echo_comments" USING btree ("archive_id", "archive_event_id", "created_at");
--> statement-breakpoint
CREATE INDEX "echo_comments_author_created_idx"
  ON "echo_comments" USING btree ("author_id", "created_at");
