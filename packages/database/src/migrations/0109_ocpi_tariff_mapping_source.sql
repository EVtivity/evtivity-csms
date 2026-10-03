-- OCPI published tariffs are generated from internal tariffs. A tariff mapping
-- now holds only the OCPI tariff id, the partner (null for every partner), and
-- the internal tariff or pricing group it is generated from (exactly one).
-- The free-form ocpi_tariff_data JSON is dropped: the OCPI server renders the
-- tariff from the internal source on every request and push. Existing mappings
-- keep their internal tariff. Duplicate OCPI tariff ids within one partner
-- scope keep the most recently updated mapping.
--
-- ocpi_roaming_sessions gets one row per charging session at most: the CPO
-- session link written when a partner's token starts a session.
ALTER TABLE "ocpi_tariff_mappings" ALTER COLUMN "tariff_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "ocpi_tariff_mappings" ADD COLUMN IF NOT EXISTS "pricing_group_id" text;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "ocpi_tariff_mappings" ADD CONSTRAINT "ocpi_tariff_mappings_pricing_group_id_pricing_groups_id_fk" FOREIGN KEY ("pricing_group_id") REFERENCES "public"."pricing_groups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "ocpi_tariff_mappings" DROP COLUMN IF EXISTS "ocpi_tariff_data";
--> statement-breakpoint
DELETE FROM "ocpi_tariff_mappings" m
USING "ocpi_tariff_mappings" newer
WHERE m."partner_id" IS NOT DISTINCT FROM newer."partner_id"
	AND m."ocpi_tariff_id" = newer."ocpi_tariff_id"
	AND (m."updated_at", m."id") < (newer."updated_at", newer."id");
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "ocpi_tariff_mappings" ADD CONSTRAINT "uq_ocpi_tariff_mappings_partner_tariff_id" UNIQUE NULLS NOT DISTINCT ("partner_id","ocpi_tariff_id");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "ocpi_tariff_mappings" ADD CONSTRAINT "ocpi_tariff_mappings_one_source" CHECK (("ocpi_tariff_mappings"."tariff_id" IS NULL) <> ("ocpi_tariff_mappings"."pricing_group_id" IS NULL));
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ocpi_tariff_mappings_pricing_group" ON "ocpi_tariff_mappings" USING btree ("pricing_group_id");
--> statement-breakpoint
DELETE FROM "ocpi_roaming_sessions" s
USING "ocpi_roaming_sessions" newer
WHERE s."charging_session_id" IS NOT NULL
	AND s."charging_session_id" = newer."charging_session_id"
	AND (s."updated_at", s."id") < (newer."updated_at", newer."id");
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_ocpi_roaming_sessions_charging";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ocpi_roaming_sessions_charging_session" ON "ocpi_roaming_sessions" USING btree ("charging_session_id") WHERE charging_session_id IS NOT NULL;
