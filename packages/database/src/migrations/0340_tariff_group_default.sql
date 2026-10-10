-- Tariff resolution fixes (v0.1.43).
--
-- charging_sessions.pricing_group_id: the pricing group the session's tariff
-- snapshot was resolved in. Split billing switches resolve only within it, so
-- an assignment or fleet membership change applies to the next session. A
-- snapshot, no FK. Active sessions get the group of their tariff.
--
-- charging_sessions.payment_gate_due_at: the worker's tariff boundary job
-- marks a session it moved from a free to a paid tariff segment; the OCPP
-- projection runs the payment gate for it and clears the mark.
--
-- Default tariff flags: the resolver falls back to the group's default only
-- when it is active and unrestricted (priority 0). A restricted or inactive
-- tariff loses the flag, and a group without a default gets its oldest active
-- unrestricted tariff as the default, so it no longer bills zero when no
-- restricted tariff matches. A group with active tariffs and no unrestricted
-- one stays without a default: the API logs it at startup, and the resolver
-- passes to the next pricing group when none of its tariffs matches.
-- Idempotent.
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "pricing_group_id" text;--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD COLUMN IF NOT EXISTS "payment_gate_due_at" timestamp with time zone;--> statement-breakpoint
UPDATE "charging_sessions" cs
SET "pricing_group_id" = t."pricing_group_id"
FROM "tariffs" t
WHERE t."id" = cs."tariff_id"
  AND cs."status" = 'active'
  AND cs."pricing_group_id" IS NULL;--> statement-breakpoint
UPDATE "tariffs"
SET "is_default" = false, "updated_at" = now()
WHERE "is_default" = true
  AND ("priority" <> 0 OR "is_active" = false);--> statement-breakpoint
UPDATE "tariffs" t
SET "is_default" = true, "updated_at" = now()
WHERE t."id" IN (
  SELECT DISTINCT ON (c."pricing_group_id") c."id"
  FROM "tariffs" c
  WHERE c."is_active" = true AND c."priority" = 0
  ORDER BY c."pricing_group_id", c."created_at", c."id"
)
AND NOT EXISTS (
  SELECT 1 FROM "tariffs" d
  WHERE d."pricing_group_id" = t."pricing_group_id" AND d."is_default" = true
);
