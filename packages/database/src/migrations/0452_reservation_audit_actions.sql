-- Reservation hardening (v0.1.45, G7, G13, G16, G17): audit actions for
-- station rejections, failed station cancels, station faults during a hold,
-- fee charges and failures, a hold taken by another driver, and scheduled
-- activations. The reservation insights read these rows. Alone in its file,
-- so the values commit before a later file uses them. Idempotent.
ALTER TYPE "reservation_audit_action" ADD VALUE IF NOT EXISTS 'station_rejected';--> statement-breakpoint
ALTER TYPE "reservation_audit_action" ADD VALUE IF NOT EXISTS 'station_cancel_failed';--> statement-breakpoint
ALTER TYPE "reservation_audit_action" ADD VALUE IF NOT EXISTS 'station_faulted';--> statement-breakpoint
ALTER TYPE "reservation_audit_action" ADD VALUE IF NOT EXISTS 'fee_charged';--> statement-breakpoint
ALTER TYPE "reservation_audit_action" ADD VALUE IF NOT EXISTS 'fee_failed';--> statement-breakpoint
ALTER TYPE "reservation_audit_action" ADD VALUE IF NOT EXISTS 'taken_by_other';--> statement-breakpoint
ALTER TYPE "reservation_audit_action" ADD VALUE IF NOT EXISTS 'activated';
