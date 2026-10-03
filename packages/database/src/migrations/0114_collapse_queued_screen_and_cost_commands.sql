-- Releases up to 0.1.35 queued a new screen message or cost update for an
-- offline station on every refresh, so a station that reconnects would get
-- hundreds of stale ones. Only the newest per display message or transaction
-- matters: the older pending ones are marked expired.
WITH keyed AS (
  SELECT "id", "station_id", "action", "created_at",
    CASE "action"
      WHEN 'SetDisplayMessage' THEN "payload" -> 'message' ->> 'id'
      WHEN 'ClearDisplayMessage' THEN "payload" ->> 'id'
      WHEN 'CostUpdated' THEN "payload" ->> 'transactionId'
    END AS "target"
  FROM "offline_command_queue"
  WHERE "status" = 'pending'
    AND "action" IN ('SetDisplayMessage', 'ClearDisplayMessage', 'CostUpdated')
),
ranked AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "station_id", "action", "target"
    ORDER BY "created_at" DESC, "id" DESC
  ) AS "rn"
  FROM keyed
  WHERE "target" IS NOT NULL
)
UPDATE "offline_command_queue" q
SET "status" = 'expired', "failed_reason" = 'Superseded by a newer queued command'
FROM ranked
WHERE q."id" = ranked."id" AND ranked."rn" > 1;
