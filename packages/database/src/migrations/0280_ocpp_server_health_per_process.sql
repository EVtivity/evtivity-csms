-- ocpp_server_health holds one row per OCPP process, keyed by the process
-- instance ID, instead of one shared 'singleton' row. Every writer names its
-- id, so the column loses its 'singleton' default. v0.1.42 processes still
-- write the 'singleton' row by name during a rolling upgrade; readers count
-- it as one process while it is fresh, and OCPP processes prune it once it
-- goes stale. Metadata only, idempotent.
ALTER TABLE "ocpp_server_health" ALTER COLUMN "id" DROP DEFAULT;
