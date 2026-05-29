-- Add 'reordered' action to station_image_audit_action enum so the
-- POST /v1/stations/:id/images/reorder handler can write an audit row
-- with semantically correct intent (instead of overloading 'updated',
-- which other paths use for single-image metadata edits).

ALTER TYPE station_image_audit_action ADD VALUE IF NOT EXISTS 'reordered';
