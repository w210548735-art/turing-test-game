CREATE SEQUENCE "user_player_number_seq"
  AS bigint
  START WITH 100001
  INCREMENT BY 1
  NO MINVALUE
  NO MAXVALUE
  CACHE 20;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "player_number" bigint;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_name" text;
--> statement-breakpoint
UPDATE "users"
SET "player_number" = nextval('"user_player_number_seq"')
WHERE "email_canonical" IS NOT NULL AND "player_number" IS NULL;
--> statement-breakpoint
UPDATE "users"
SET "display_name" = '图灵玩家'
WHERE "email_canonical" IS NOT NULL AND "display_name" IS NULL;
--> statement-breakpoint
ALTER TABLE "users"
  ADD CONSTRAINT "users_player_number_registered_check"
  CHECK (
    ("email_canonical" IS NULL AND "player_number" IS NULL)
    OR
    ("email_canonical" IS NOT NULL AND "player_number" >= 100001)
  );
--> statement-breakpoint
ALTER TABLE "users"
  ADD CONSTRAINT "users_display_name_length_check"
  CHECK (
    "display_name" IS NULL
    OR char_length(BTRIM("display_name")) BETWEEN 2 AND 18
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "users_player_number_uidx"
  ON "users" USING btree ("player_number");
