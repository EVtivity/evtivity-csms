-- Backfill connector_type for auto-discovered connectors.
--
-- The OCPP StatusNotification message does not carry the connector type.
-- The auto-discovery path in event-projections.ts originally inserted those
-- rows with connector_type = NULL, and the stations-list aggregation in
-- routes/stations.ts filters out NULL types via
-- `AND c4.connector_type IS NOT NULL`. The net effect: every connector on
-- an auto-discovered station was hidden from the listing's Connectors
-- column.
--
-- The event-projections fix sets new auto-created rows to 'Unknown'. This
-- migration backfills the same value into existing auto-created rows that
-- already have NULL so the listing reflects them too. Manually-created
-- connectors with a real type set are not touched.

UPDATE connectors
SET connector_type = 'Unknown'
WHERE connector_type IS NULL
  AND auto_created = true;
