// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomInt } from 'node:crypto';
import type postgres from 'postgres';
import { buildCampaignUpdateFirmware, publishOcppCommand, type PubSubClient } from '@evtivity/lib';
import { rejectFirmwareUpdate, applyFirmwareCampaignStationStatus } from './firmware-updates.js';

/** A random UpdateFirmware requestId (OCPP integer, positive). */
export function newFirmwareRequestId(): number {
  return randomInt(1, 2_147_483_647);
}

interface ClaimedDispatch {
  campaign_id: string;
  firmware_url: string;
  signing_certificate: string | null;
  signature: string | null;
  retries: number | null;
  retry_interval: number | null;
  install_date_time: Date | null;
}

/**
 * Sends the update of every active campaign the station is waiting for: it was
 * offline when the campaign started. Each campaign station is claimed once by
 * setting `dispatched_at` (P7), so a reconnect, a second OCPP pod or a retry
 * never sends the same campaign twice. The firmware_updates row is written
 * before the publish (P4); a publish that fails ends the station as Rejected
 * (CommandFailed), so the campaign can still complete. Returns the campaign ids
 * sent.
 */
export async function dispatchPendingFirmwareCampaigns(
  sql: postgres.Sql,
  pubsub: PubSubClient,
  station: { stationUuid: string; stationOcppId: string },
  log?: { warn: (obj: unknown, msg?: string) => void },
): Promise<string[]> {
  const claimed = await sql<ClaimedDispatch[]>`
    UPDATE firmware_campaign_stations fcs
    SET dispatched_at = now(), updated_at = now()
    FROM firmware_campaigns fc
    WHERE fcs.campaign_id = fc.id
      AND fc.status = 'active'
      AND fcs.station_id = ${station.stationUuid}
      AND fcs.status = 'pending'
      AND fcs.dispatched_at IS NULL
    RETURNING fc.id AS campaign_id, fc.firmware_url, fc.signing_certificate, fc.signature,
      fc.retries, fc.retry_interval, fc.install_date_time
  `;
  const sent: string[] = [];
  for (const row of claimed) {
    const requestId = newFirmwareRequestId();
    // Everything after the claim runs inside the try: a failed insert or
    // publish must end this campaign station (failed, CommandFailed) and let the
    // loop go on, or the claimed row stays pending with dispatched_at set and
    // the campaign never completes.
    try {
      const retrieveDateTime = new Date();
      await sql`
        INSERT INTO firmware_updates (station_id, request_id, firmware_url, retrieve_date_time, campaign_id, initiated_at)
        VALUES (${station.stationUuid}, ${requestId}, ${row.firmware_url}, ${retrieveDateTime}, ${row.campaign_id}, now())
        ON CONFLICT (station_id, request_id) WHERE request_id IS NOT NULL DO NOTHING
      `;
      const payload = buildCampaignUpdateFirmware(
        {
          firmwareUrl: row.firmware_url,
          signingCertificate: row.signing_certificate,
          signature: row.signature,
          retries: row.retries,
          retryInterval: row.retry_interval,
          installDateTime: row.install_date_time,
        },
        requestId,
        retrieveDateTime,
      );
      await publishOcppCommand(pubsub, {
        stationId: station.stationOcppId,
        action: 'UpdateFirmware',
        payload,
      });
      sent.push(row.campaign_id);
    } catch (err) {
      log?.warn(
        { err, campaignId: row.campaign_id, stationId: station.stationOcppId },
        'firmware-campaign: connect-time dispatch not sent',
      );
      await failClaimedDispatch(sql, station, row.campaign_id, requestId, log);
    }
  }
  return sent;
}

async function failClaimedDispatch(
  sql: postgres.Sql,
  station: { stationUuid: string; stationOcppId: string },
  campaignId: string,
  requestId: number,
  log?: { warn: (obj: unknown, msg?: string) => void },
): Promise<void> {
  const audit = { actor: 'system' as const, actorLabel: 'Firmware campaign dispatch' };
  try {
    const rejected = await rejectFirmwareUpdate(sql, {
      stationUuid: station.stationUuid,
      requestId,
      reasonCode: 'CommandFailed',
      additionalInfo: 'The command could not be sent',
      ...audit,
    });
    if (rejected == null) {
      await applyFirmwareCampaignStationStatus(sql, {
        campaignId,
        stationUuid: station.stationUuid,
        status: 'failed',
        errorInfo: 'CommandFailed',
        ...audit,
      });
    }
  } catch (err) {
    // fail-open: the next campaign of this station is still sent; the row
    // stays pending and the operator can cancel the campaign.
    log?.warn(
      { err, campaignId, stationId: station.stationOcppId },
      'firmware-campaign: failed dispatch could not be recorded',
    );
  }
}
