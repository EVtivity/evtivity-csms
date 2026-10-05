-- Invoices for sessions already paid were stored as 'issued' (beta.1 and
-- earlier). Moves an 'issued' invoice to 'paid' when every line on it was
-- collected, the rule invoiceStatusFor applies to new invoices:
-- a session line when the session cost nothing, or its payment record is
-- captured, partially_refunded or refunded and the captured amount covers the
-- final cost; a fee line when its payment record is captured,
-- partially_refunded or refunded. Invoices without lines and every other
-- status are left alone. Idempotent: a second run finds nothing to change.

UPDATE invoices i
SET status = 'paid', updated_at = now()
WHERE i.status = 'issued'
  AND EXISTS (SELECT 1 FROM invoice_line_items li WHERE li.invoice_id = i.id)
  AND NOT EXISTS (
    SELECT 1
    FROM invoice_line_items li
    LEFT JOIN charging_sessions cs ON cs.id = li.session_id
    LEFT JOIN payment_records pr ON pr.session_id = li.session_id
    LEFT JOIN payment_records fee ON fee.id = li.payment_record_id
    WHERE li.invoice_id = i.id
      AND NOT (
        (
          li.session_id IS NOT NULL
          AND cs.final_cost_cents IS NOT NULL
          AND (
            cs.final_cost_cents = 0
            OR (
              pr.status IN ('captured', 'partially_refunded', 'refunded')
              AND coalesce(pr.captured_amount_cents, 0) >= cs.final_cost_cents
            )
          )
        )
        OR (
          li.session_id IS NULL
          AND li.payment_record_id IS NOT NULL
          AND fee.status IN ('captured', 'partially_refunded', 'refunded')
        )
      )
  );
