-- OCPP 2.1 FirmwareStatusNotificationRequest defines 14 values for the
-- FirmwareStatusEnumType. The initial enum was missing InstallRebooting and
-- InstallScheduled (and contained a typo, InstallRescheduled, that no station
-- ever sends). Without these, any TransactionEvent->firmware_updates upsert
-- carrying a status of InstallRebooting or InstallScheduled crashes with
-- invalid_text_representation and the projection drops the notification on the
-- floor. OCTT module L (firmware management) exercises both values, so this
-- gap also fails conformance.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a multi-statement transaction
-- block in older PostgreSQL versions. Each statement here is independent and
-- idempotent, so reapplying the migration is safe.
ALTER TYPE "public"."firmware_update_status" ADD VALUE IF NOT EXISTS 'InstallRebooting';
ALTER TYPE "public"."firmware_update_status" ADD VALUE IF NOT EXISTS 'InstallScheduled';
