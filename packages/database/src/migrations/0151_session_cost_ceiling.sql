-- The cost ceiling of a charging session: the authorized amount of a guest's
-- card hold (OCPP 2.1 C25: the authorization is the ceiling for the cost).
-- The cost assembly bills at most this amount. Null: no ceiling. Idempotent.

ALTER TABLE charging_sessions ADD COLUMN IF NOT EXISTS cost_ceiling_cents integer;
