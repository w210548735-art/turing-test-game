CREATE TYPE "public"."account_role" AS ENUM('player', 'root');
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" "account_role" DEFAULT 'player' NOT NULL;
--> statement-breakpoint
CREATE INDEX "users_role_status_idx" ON "users" USING btree ("role", "status");
