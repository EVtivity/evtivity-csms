-- Invoice claim contract (v0.1.42): charging_sessions.invoice_id and
-- payment_records.invoice_id become the only claim, and
-- invoice_number_counters the only numbering v0.1.42 uses.
--
-- Needs every install on v0.1.41 first. Processes of v0.1.40 or older invoice
-- without a claim and number from invoice_number_seq, so with such a process
-- still running a session could be invoiced twice. The first block refuses the
-- migration while a connection of a release before v0.1.41 is open on this
-- database (`postgres.js` before v0.1.38, `evtivity@<version>` from v0.1.38 on).
-- A checkout whose own version is lower (an unbumped development tree)
-- compares with its own version, like guardVersion() in process-versions.ts.
--
-- Then: the invoice counter takes the sequence value when it is ahead (the
-- sequence stays: v0.1.41 pods still number through it during the rolling
-- upgrade, always above the counter; v0.1.43 drops it), claims that point at
-- void invoices are cleared, and
-- every session and reservation fee charge on a line of a live invoice
-- (kind 'invoice', not void, not credited; the oldest when on two) is claimed
-- for it. Credit notes mirror the lines they credit and claim nothing, and the
-- sessions of a credited invoice stay unclaimed. Row locks only, idempotent.

DO $$
DECLARE
  min_version int[] := ARRAY[0, 1, 41];
  own_version int[] := (regexp_match(current_setting('application_name'), '^evtivity@v?(\d+)\.(\d+)\.(\d+)'))::int[];
  old_names text;
BEGIN
  IF own_version IS NOT NULL AND own_version < min_version THEN
    min_version := own_version;
  END IF;
  SELECT string_agg(DISTINCT a.application_name, ', ') INTO old_names
  FROM pg_stat_activity a
  WHERE a.datname = current_database()
    AND a.pid <> pg_backend_pid()
    AND (a.application_name = 'postgres.js'
         OR (a.application_name LIKE 'evtivity@%'
             AND COALESCE((regexp_match(a.application_name, '^evtivity@v?(\d+)\.(\d+)\.(\d+)'))::int[] < min_version, true)));
  IF old_names IS NOT NULL THEN
    RAISE EXCEPTION 'v0.1.42 needs every EVtivity process on v0.1.41 first; connections of an older release are open (%). Upgrade to v0.1.41 and let it roll out, or stop every older process, then migrate again', old_names;
  END IF;
END $$;--> statement-breakpoint
DO $$
DECLARE
  sequence_value bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relkind = 'S' AND relname = 'invoice_number_seq') THEN
    SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END INTO sequence_value
    FROM invoice_number_seq;
    UPDATE "invoice_number_counters"
    SET "value" = GREATEST("value", sequence_value)
    WHERE "name" = 'invoice';
  END IF;
END $$;--> statement-breakpoint
UPDATE "charging_sessions" cs
SET "invoice_id" = NULL
FROM "invoices" i
WHERE i."id" = cs."invoice_id" AND i."status" = 'void';--> statement-breakpoint
UPDATE "payment_records" pr
SET "invoice_id" = NULL, "updated_at" = now()
FROM "invoices" i
WHERE i."id" = pr."invoice_id" AND i."status" = 'void';--> statement-breakpoint
UPDATE "charging_sessions" cs
SET "invoice_id" = claimed."invoice_id"
FROM (
  SELECT DISTINCT ON (li."session_id") li."session_id", li."invoice_id"
  FROM "invoice_line_items" li
  JOIN "invoices" i ON i."id" = li."invoice_id"
  WHERE li."session_id" IS NOT NULL
    AND i."kind" = 'invoice' AND i."status" NOT IN ('void', 'credited')
  ORDER BY li."session_id", i."created_at", i."id"
) claimed
WHERE cs."id" = claimed."session_id" AND cs."invoice_id" IS NULL;--> statement-breakpoint
UPDATE "payment_records" pr
SET "invoice_id" = claimed."invoice_id", "updated_at" = now()
FROM (
  SELECT DISTINCT ON (li."payment_record_id") li."payment_record_id", li."invoice_id"
  FROM "invoice_line_items" li
  JOIN "invoices" i ON i."id" = li."invoice_id"
  WHERE li."payment_record_id" IS NOT NULL
    AND i."kind" = 'invoice' AND i."status" NOT IN ('void', 'credited')
  ORDER BY li."payment_record_id", i."created_at", i."id"
) claimed
WHERE pr."id" = claimed."payment_record_id" AND pr."invoice_id" IS NULL;
