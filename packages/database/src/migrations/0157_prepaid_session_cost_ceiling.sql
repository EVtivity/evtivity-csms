-- Prepaid sessions running during the upgrade get their cost ceiling. The
-- Started projection stamps a prepaid token's positive balance as the
-- session's cost_ceiling_cents (C17.FR.03), but a session an older OCPP pod
-- started has none, so it would be billed and debited in full. Stamp the
-- same value the start path uses: the token's balance when positive. The
-- balance is debited only at settlement, so it is still the credit the
-- session started with. Only active sessions without a ceiling: a guest's
-- hold and an already stamped credit stay, and ended sessions are not
-- touched. Free vend sessions are never billed. Idempotent.

UPDATE charging_sessions cs
SET cost_ceiling_cents = dt.prepaid_balance_cents, updated_at = now()
FROM driver_tokens dt
WHERE dt.id = cs.token_id
  AND cs.status = 'active'
  AND cs.cost_ceiling_cents IS NULL
  AND cs.free_vend = false
  AND dt.prepaid_balance_cents > 0;
