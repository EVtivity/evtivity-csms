-- Seed the operator-tunable TTL (seconds) for one-shot event-driven station
-- messages. Used as the OCPP 2.1 SetDisplayMessage endDateTime offset AND
-- as the in-process autoClearMs follow-up that the dispatcher schedules for
-- OCPP 1.6 stations and defensively on 2.1 firmwares that ignore endDateTime.
INSERT INTO settings (key, value) VALUES
  ('stationMessage.eventMessageTtlSeconds', '30'::jsonb)
ON CONFLICT (key) DO NOTHING;
