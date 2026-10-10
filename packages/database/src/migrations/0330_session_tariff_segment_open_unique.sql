-- At most one open tariff segment per session (finding B1). Two concurrent
-- segment switches (the tariff boundary job and a MeterValues projection)
-- could each close the open segment and open a new one, leaving two open
-- segments that both bill the rest of the session. A session with several
-- open segments keeps its newest one open; each older one is closed where the
-- next open segment starts, with that segment's starting energy, so nothing
-- is billed twice. Then the partial unique index makes a second open segment
-- impossible. Idempotent: the second run finds no duplicate and the index.
WITH open_segments AS (
  SELECT id,
         LEAD(started_at) OVER w AS next_started_at,
         LEAD(energy_wh_start) OVER w AS next_energy_wh_start
  FROM session_tariff_segments
  WHERE ended_at IS NULL
  WINDOW w AS (PARTITION BY session_id ORDER BY started_at, id)
)
UPDATE session_tariff_segments s
SET ended_at = o.next_started_at,
    energy_wh_end = GREATEST(s.energy_wh_start, o.next_energy_wh_start),
    duration_minutes = GREATEST(0, EXTRACT(EPOCH FROM (o.next_started_at - s.started_at)) / 60)
FROM open_segments o
WHERE s.id = o.id AND o.next_started_at IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_tariff_segments_open
  ON session_tariff_segments (session_id)
  WHERE ended_at IS NULL;
