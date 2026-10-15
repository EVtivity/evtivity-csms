// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { writeAudit, type AuditActor } from './audit.js';
import { firmwareCampaignAuditLog } from '../schema/audit.js';

/**
 * Firmware update statuses that end an update. `Rejected` is the CSMS-side
 * status of an update the station never started: it refused the
 * UpdateFirmware command (Rejected, InvalidCertificate, RevokedCertificate),
 * answered with an error, or the queued command expired before the station
 * came back. `status_info.reasonCode` says which. A later report never moves a
 * row out of one of these (P5).
 */
export const FIRMWARE_UPDATE_TERMINAL_STATUSES = [
  'Installed',
  'InstallationFailed',
  'InstallVerificationFailed',
  'InvalidSignature',
  'DownloadFailed',
  'Rejected',
] as const;

const TERMINAL: string[] = [...FIRMWARE_UPDATE_TERMINAL_STATUSES];

/** UpdateFirmware response statuses that mean the station did not start the update. */
export const FIRMWARE_UPDATE_REFUSED_RESPONSES = [
  'Rejected',
  'InvalidCertificate',
  'RevokedCertificate',
] as const;

export type FirmwareCampaignStationStatus =
  | 'pending'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'installed'
  | 'failed';

/**
 * Campaign station status for each FirmwareStatus the station reports (2.1 and
 * 1.6). DownloadScheduled and Idle leave the station as it is.
 */
export const FIRMWARE_STATUS_TO_CAMPAIGN_STATION: Readonly<
  Record<string, FirmwareCampaignStationStatus>
> = {
  Downloading: 'downloading',
  DownloadPaused: 'downloading',
  Downloaded: 'downloaded',
  SignatureVerified: 'downloaded',
  InstallScheduled: 'downloaded',
  InstallRebooting: 'installing',
  Installing: 'installing',
  Installed: 'installed',
  DownloadFailed: 'failed',
  InstallationFailed: 'failed',
  InvalidSignature: 'failed',
  InstallVerificationFailed: 'failed',
};

export function isTerminalFirmwareUpdateStatus(status: string | null | undefined): boolean {
  return (
    status != null && (FIRMWARE_UPDATE_TERMINAL_STATUSES as readonly string[]).includes(status)
  );
}

export interface CampaignStationUpdate {
  /** The station row changed (it was not terminal yet). */
  changed: boolean;
  /** This update completed the campaign (every station terminal). */
  campaignCompleted: boolean;
}

/**
 * Moves one station of a campaign to `status`, unless the station already
 * finished (installed and failed are sticky), then completes the campaign when
 * every station is terminal and writes the completion audit. Only an active
 * campaign completes: a cancelled one keeps its status.
 */
export async function applyFirmwareCampaignStationStatus(
  sql: postgres.Sql,
  args: {
    campaignId: string;
    stationUuid: string;
    status: FirmwareCampaignStationStatus;
    errorInfo?: string | null;
    actor: AuditActor;
    actorLabel: string;
  },
): Promise<CampaignStationUpdate> {
  const errorInfo = args.status === 'failed' ? (args.errorInfo ?? null) : null;
  const updated = await sql`
    UPDATE firmware_campaign_stations
    SET status = ${args.status}::firmware_campaign_station_status,
        error_info = CASE WHEN ${args.status} = 'failed' THEN ${errorInfo} ELSE error_info END,
        updated_at = now()
    WHERE station_id = ${args.stationUuid}
      AND campaign_id = ${args.campaignId}
      AND status NOT IN ('installed', 'failed')
  `;
  const campaignCompleted = await completeFirmwareCampaignIfDone(sql, args.campaignId, {
    actor: args.actor,
    actorLabel: args.actorLabel,
  });
  return { changed: updated.count > 0, campaignCompleted };
}

/**
 * Completes an active campaign whose stations are all terminal and writes the
 * audit entry. Returns whether this call completed it.
 */
export async function completeFirmwareCampaignIfDone(
  sql: postgres.Sql,
  campaignId: string,
  audit: { actor: AuditActor; actorLabel: string },
): Promise<boolean> {
  const completed = await sql`
    UPDATE firmware_campaigns
    SET status = 'completed', updated_at = now()
    WHERE id = ${campaignId}
      AND status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM firmware_campaign_stations fcs
        WHERE fcs.campaign_id = ${campaignId}
          AND fcs.status NOT IN ('installed', 'failed')
      )
    RETURNING id
  `;
  if (completed.count === 0) return false;
  await writeAudit(
    { table: firmwareCampaignAuditLog, idColumn: 'campaign_id' },
    {
      entityId: campaignId,
      entityIdSnapshot: campaignId,
      action: 'completed',
      actor: audit.actor,
      actorLabel: audit.actorLabel,
      before: { status: 'active' },
      after: { status: 'completed' },
    },
  );
  return true;
}

/**
 * Records that a station never started the firmware update `requestId`
 * (status `Rejected`, `reasonCode` in status_info) and fails its campaign
 * station. A row already terminal is left alone. Returns the campaign the
 * update belongs to, or null when no open row matched or it has no campaign.
 */
export async function rejectFirmwareUpdate(
  sql: postgres.Sql,
  args: {
    stationUuid: string;
    requestId: number;
    reasonCode: string;
    additionalInfo?: string | null;
    actor: AuditActor;
    actorLabel: string;
  },
): Promise<{ campaignId: string; campaignCompleted: boolean } | null> {
  const statusInfo: Record<string, string> = { reasonCode: args.reasonCode.slice(0, 20) };
  if (args.additionalInfo != null && args.additionalInfo !== '') {
    statusInfo.additionalInfo = args.additionalInfo.slice(0, 1024);
  }
  const rows = await sql<Array<{ campaign_id: string | null }>>`
    UPDATE firmware_updates
    SET status = 'Rejected',
        status_info = ${sql.json(statusInfo)},
        last_status_at = now(),
        updated_at = now()
    WHERE station_id = ${args.stationUuid}
      AND request_id = ${args.requestId}
      AND (status IS NULL OR status::text <> ALL(${TERMINAL}::text[]))
    RETURNING campaign_id
  `;
  const campaignId = rows[0]?.campaign_id ?? null;
  if (campaignId == null) return null;
  const { campaignCompleted } = await applyFirmwareCampaignStationStatus(sql, {
    campaignId,
    stationUuid: args.stationUuid,
    status: 'failed',
    errorInfo: args.reasonCode,
    actor: args.actor,
    actorLabel: args.actorLabel,
  });
  return { campaignId, campaignCompleted };
}

/**
 * A cancelled campaign stops what has not reached a station yet: the
 * UpdateFirmware commands of the campaign still queued for an offline station
 * (`offline_command_queue`, `pending`) are failed, so the station does not
 * install the firmware on its next connection, and their updates end as
 * Rejected (`CampaignCanceled`). The `status = 'pending'` guard loses cleanly to
 * a drain that already sent the command. Returns the number dropped.
 */
export async function dropQueuedCampaignFirmwareUpdates(
  sql: postgres.Sql,
  campaignId: string,
): Promise<number> {
  const dropped = await sql<Array<{ station_uuid: string; request_id: number }>>`
    UPDATE offline_command_queue o
    SET status = 'failed', failed_reason = 'Firmware campaign cancelled'
    FROM firmware_updates fu
    JOIN charging_stations cs ON cs.id = fu.station_id
    WHERE fu.campaign_id = ${campaignId}
      AND fu.request_id IS NOT NULL
      AND o.station_id = cs.station_id
      AND o.action IN ('UpdateFirmware', 'SignedUpdateFirmware')
      AND o.status = 'pending'
      AND o.payload->>'requestId' = fu.request_id::text
    RETURNING fu.station_id AS station_uuid, fu.request_id
  `;
  for (const row of dropped) {
    await rejectFirmwareUpdate(sql, {
      stationUuid: row.station_uuid,
      requestId: row.request_id,
      reasonCode: 'CampaignCanceled',
      additionalInfo: 'Queued for an offline station when the campaign was cancelled',
      actor: 'system',
      actorLabel: 'Firmware campaign cancel',
    });
  }
  return dropped.length;
}

/**
 * The station answered AcceptedCanceled: it cancelled the update it was
 * running for the new one (L01.FR.24) and may never report the cancelled one
 * again. Fails the campaign station of every other open campaign update of
 * the station, so its campaign can still complete. The firmware_updates rows
 * keep their last reported status.
 */
export async function failCanceledFirmwareCampaignUpdates(
  sql: postgres.Sql,
  args: { stationUuid: string; requestId: number; actor: AuditActor; actorLabel: string },
): Promise<Array<{ campaignId: string; campaignCompleted: boolean }>> {
  const rows = await sql<Array<{ campaign_id: string }>>`
    SELECT DISTINCT campaign_id FROM firmware_updates
    WHERE station_id = ${args.stationUuid}
      AND campaign_id IS NOT NULL
      AND request_id IS DISTINCT FROM ${args.requestId}
      AND (status IS NULL OR status::text <> ALL(${TERMINAL}::text[]))
  `;
  const touched: Array<{ campaignId: string; campaignCompleted: boolean }> = [];
  for (const row of rows) {
    const { changed, campaignCompleted } = await applyFirmwareCampaignStationStatus(sql, {
      campaignId: row.campaign_id,
      stationUuid: args.stationUuid,
      status: 'failed',
      errorInfo: 'AcceptedCanceled',
      actor: args.actor,
      actorLabel: args.actorLabel,
    });
    if (changed) touched.push({ campaignId: row.campaign_id, campaignCompleted });
  }
  return touched;
}
