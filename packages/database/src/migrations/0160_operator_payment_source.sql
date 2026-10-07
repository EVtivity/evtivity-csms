-- Off-session charges the CSMS starts for an operator get the payment source
-- `operator` (the session re-bill, marked metadata.rebill, and the
-- reservation cancellation and no-show fees). They were written as
-- `web_portal`. A prepaid re-bill debit keeps `prepaid`. Idempotent.
UPDATE "payment_records"
SET "payment_source" = 'operator'
WHERE "payment_source" = 'web_portal'
  AND ("metadata" ? 'rebill' OR "charge_type" <> 'session');
