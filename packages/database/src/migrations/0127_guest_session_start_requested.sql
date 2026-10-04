-- Payments P10 Part B: a guest session whose hold needed 3D Secure is started
-- by the details route, which can run more than once (return page reload, a
-- webhook that attached the hold first). start_requested_at marks the one
-- request that sent RequestStartTransaction. Metadata-only (nullable, no default).
ALTER TABLE "guest_sessions" ADD COLUMN IF NOT EXISTS "start_requested_at" timestamp with time zone;
