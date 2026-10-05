-- Payments P8 (contract, v0.1.39), step 3 of 3: validate the check of 0149. VALIDATE
-- takes SHARE UPDATE EXCLUSIVE, so payment reads and writes continue while
-- it scans payment_records. A no-op once validated.
ALTER TABLE "payment_records" VALIDATE CONSTRAINT "payment_records_provider_payment_id_check";
