-- Drop invoice_number_seq (v0.1.43). Invoice numbers come only from the
-- invoice row of invoice_number_counters since v0.1.42, which no longer reads
-- or moves the sequence.
--
-- Needs every install on v0.1.42 first. v0.1.41 processes number invoices
-- through the sequence, so with such a process still running its invoices
-- would fail once the sequence is gone. The first block refuses the migration
-- while a connection of a release before v0.1.42 is open on this database
-- (`postgres.js` before v0.1.38, `evtivity@<version>` from v0.1.38 on). A
-- checkout whose own version is lower (an unbumped development tree) compares
-- with its own version, like guardVersion() in process-versions.ts. Versions
-- compare by semver precedence: a prerelease of v0.1.42 (`0.1.42-alpha.3`)
-- ranks below v0.1.42, since an early v0.1.42 prerelease may still number
-- invoices through the sequence. The fourth element is 0 for a prerelease and
-- 1 for a release.
--
-- Then the invoice counter takes the sequence value when it is ahead (as in
-- 0270), so no number the sequence handed out is issued again, and the
-- sequence is dropped. Idempotent: the second run finds no sequence.

DO $$
DECLARE
  min_version int[] := ARRAY[0, 1, 42, 1];
  own_match text[] := regexp_match(current_setting('application_name'), '^evtivity@v?(\d+)\.(\d+)\.(\d+)(-)?');
  own_version int[];
  old_names text;
BEGIN
  IF own_match IS NOT NULL THEN
    own_version := ARRAY[own_match[1]::int, own_match[2]::int, own_match[3]::int,
                         CASE WHEN own_match[4] IS NULL THEN 1 ELSE 0 END];
  END IF;
  IF own_version IS NOT NULL AND own_version < min_version THEN
    min_version := own_version;
  END IF;
  SELECT string_agg(DISTINCT a.application_name, ', ') INTO old_names
  FROM pg_stat_activity a
  WHERE a.datname = current_database()
    AND a.pid <> pg_backend_pid()
    AND (a.application_name = 'postgres.js'
         OR (a.application_name LIKE 'evtivity@%'
             AND COALESCE((SELECT ARRAY[m[1]::int, m[2]::int, m[3]::int,
                                        CASE WHEN m[4] IS NULL THEN 1 ELSE 0 END]
                           FROM regexp_match(a.application_name, '^evtivity@v?(\d+)\.(\d+)\.(\d+)(-)?') AS r(m)
                           WHERE m IS NOT NULL) < min_version, true)));
  IF old_names IS NOT NULL THEN
    RAISE EXCEPTION 'v0.1.43 needs every EVtivity process on v0.1.42 first; connections of an older release are open (%). Upgrade to v0.1.42 and let it roll out, or stop every older process, then migrate again', old_names;
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
DROP SEQUENCE IF EXISTS invoice_number_seq;
