-- One stored cost split per charging session and price snapshots per tariff
-- segment (issue #33).
--
-- charging_sessions: the tax basis and the reservation fee of the tariff
-- snapshot, and the net amount, tax, and breakdown of the cost, kept with
-- current_cost_cents / final_cost_cents (net_cents + tax_cents equals the
-- cost). session_tariff_segments: the prices of the segment's tariff, copied
-- when the segment opens, so editing a tariff never re-prices a session.
--
-- Backfill (amounts charged never change):
-- - Sessions with a cost get net_cents, tax_cents, and a breakdown without
--   components: the cost split at the snapshot tax rate, round(cost / (1 +
--   rate)) as the net, the way netFromGross splits it. Split-billed sessions
--   from before this change keep that single-rate split.
-- - Sessions with a tariff snapshot get tax_basis 'net' (prices were always
--   entered without tax). Reserved sessions get the reservation fee of their
--   tariff, which the final cost read from the tariff until now.
-- - The segments of active sessions get the prices of their tariff now.
--   Segments of ended sessions stay without a snapshot: those sessions keep
--   the cost stored when they ended.

ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "tariff_reservation_fee_per_minute" numeric;
--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "tax_basis" varchar(5);
--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "net_cents" integer;
--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "tax_cents" integer;
--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "cost_breakdown" jsonb;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "charging_sessions"
    ADD CONSTRAINT "chk_charging_sessions_tax_basis" CHECK ("tax_basis" IN ('net', 'gross'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "session_tariff_segments" ADD COLUMN IF NOT EXISTS "price_snapshot" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "session_tariff_segments" ADD COLUMN IF NOT EXISTS "price_per_kwh" numeric;
--> statement-breakpoint
ALTER TABLE "session_tariff_segments" ADD COLUMN IF NOT EXISTS "price_per_minute" numeric;
--> statement-breakpoint
ALTER TABLE "session_tariff_segments" ADD COLUMN IF NOT EXISTS "price_per_session" numeric;
--> statement-breakpoint
ALTER TABLE "session_tariff_segments" ADD COLUMN IF NOT EXISTS "idle_fee_price_per_minute" numeric;
--> statement-breakpoint
ALTER TABLE "session_tariff_segments" ADD COLUMN IF NOT EXISTS "reservation_fee_per_minute" numeric;
--> statement-breakpoint
ALTER TABLE "session_tariff_segments" ADD COLUMN IF NOT EXISTS "tax_rate" numeric;
--> statement-breakpoint
UPDATE "charging_sessions" s
SET "tariff_reservation_fee_per_minute" = t."reservation_fee_per_minute"
FROM "tariffs" t
WHERE t."id" = s."tariff_id"
  AND s."reservation_id" IS NOT NULL
  AND s."tax_basis" IS NULL
  AND s."tariff_reservation_fee_per_minute" IS NULL;
--> statement-breakpoint
UPDATE "charging_sessions"
SET "tax_basis" = 'net'
WHERE "tariff_id" IS NOT NULL AND "tax_basis" IS NULL;
--> statement-breakpoint
UPDATE "session_tariff_segments" sts
SET "price_snapshot" = true,
    "price_per_kwh" = t."price_per_kwh",
    "price_per_minute" = t."price_per_minute",
    "price_per_session" = t."price_per_session",
    "idle_fee_price_per_minute" = t."idle_fee_price_per_minute",
    "reservation_fee_per_minute" = t."reservation_fee_per_minute",
    "tax_rate" = t."tax_rate"
FROM "tariffs" t, "charging_sessions" s
WHERE t."id" = sts."tariff_id"
  AND s."id" = sts."session_id"
  AND s."status" = 'active'
  AND sts."price_snapshot" = false;
--> statement-breakpoint
UPDATE "charging_sessions" s
SET "net_cents" = c."net",
    "tax_cents" = c."gross" - c."net",
    "cost_breakdown" = jsonb_build_object(
      'basis', 'net',
      'netCents', c."net",
      'taxCents', c."gross" - c."net",
      'grossCents', c."gross",
      'taxLines', CASE
        WHEN c."gross" = 0 THEN '[]'::jsonb
        ELSE jsonb_build_array(jsonb_build_object(
          'taxRate', c."rate",
          'netCents', c."net",
          'taxCents', c."gross" - c."net"
        ))
      END,
      'components', NULL
    )
FROM (
  SELECT "id",
         "gross",
         "rate",
         CASE WHEN "rate" > 0 THEN round("gross"::numeric / (1 + "rate"))::integer ELSE "gross" END AS "net"
  FROM (
    SELECT "id",
           coalesce("final_cost_cents", "current_cost_cents") AS "gross",
           coalesce("tariff_tax_rate", 0) AS "rate"
    FROM "charging_sessions"
    WHERE "cost_breakdown" IS NULL
      AND coalesce("final_cost_cents", "current_cost_cents") IS NOT NULL
  ) costs
) c
WHERE s."id" = c."id";
