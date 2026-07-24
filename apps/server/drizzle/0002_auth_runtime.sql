-- 账户认证运行时持久化：账户行不再伪造游客 Session Token，并支持设备多账号关联
ALTER TYPE "public"."verification_token_purpose"
  ADD VALUE IF NOT EXISTS 'websocket_ticket';
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "session_token_hash" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "risk_score" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "devices"
  ADD CONSTRAINT "devices_risk_score_nonnegative"
  CHECK ("devices"."risk_score" >= 0);
--> statement-breakpoint

CREATE TABLE "device_accounts" (
  "device_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "linked_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "device_accounts_device_user_pk" PRIMARY KEY ("device_id", "user_id")
);
--> statement-breakpoint
ALTER TABLE "device_accounts"
  ADD CONSTRAINT "device_accounts_device_id_devices_id_fk"
  FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "device_accounts"
  ADD CONSTRAINT "device_accounts_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "device_accounts" ("device_id", "user_id", "linked_at")
SELECT "id", "user_id", "created_at"
FROM "devices"
WHERE "user_id" IS NOT NULL
ON CONFLICT ("device_id", "user_id") DO NOTHING;
--> statement-breakpoint
CREATE INDEX "device_accounts_user_linked_idx"
  ON "device_accounts" USING btree ("user_id", "linked_at");
