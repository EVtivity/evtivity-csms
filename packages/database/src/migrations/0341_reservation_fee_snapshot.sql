-- Reservation fee terms snapshotted at creation (v0.1.43, T3 B4).
--
-- The cancellation and no-show fees are priced from the terms in effect when
-- the driver reserved, not from a tariff or setting edited afterwards:
-- fee_tax_basis (company.taxBasis, 'net' or 'gross', the basis the fee
-- amounts are entered in), fee_tax_rate (the tax rate of the tariff the
-- driver resolved at the station, a fraction), fee_per_minute (that tariff's
-- reservation holding fee per minute, the no-show fee) and
-- fee_cancellation_cents (reservation.cancellationFeeCents at creation).
-- fee_tax_basis set means the snapshot was taken. A reservation created
-- before this migration keeps the columns null and is charged on the terms
-- current at the charge (resolveReservationFeeTerms). Idempotent.
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "fee_tax_basis" varchar(5);--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "fee_tax_rate" numeric;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "fee_per_minute" numeric;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "fee_cancellation_cents" integer;
