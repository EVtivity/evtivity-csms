// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { client, rejectFirmwareUpdate } from '@evtivity/database';
import type { Logger } from 'pino';

const FIRMWARE_UPDATE_ACTIONS = new Set(['UpdateFirmware', 'SignedUpdateFirmware']);

/**
 * Expires the queued commands whose time ran out. The same UPDATE masks every
 * URL password of the payload (`evtivity_mask_url_passwords_jsonb`, the rule
 * of `maskUrlPassword`): nothing delivers an expired row again. The request id
 * the firmware step reads is no URL and stays.
 */
export async function offlineCommandCleanupHandler(log: Logger): Promise<void> {
  const expired = await client<
    Array<{ id: number; action: string; payload: unknown; station_uuid: string | null }>
  >`
    UPDATE offline_command_queue q SET status = 'expired',
      payload = public.evtivity_mask_url_passwords_jsonb(q.payload)
    WHERE q.status = 'pending' AND q.expires_at <= now()
    RETURNING q.id, q.action, q.payload,
      (SELECT cs.id FROM charging_stations cs WHERE cs.station_id = q.station_id) AS station_uuid
  `;

  if (expired.length > 0) {
    log.info({ count: expired.length }, 'Expired stale offline commands');
  }

  // A firmware update that expired in the queue never reached its station, so
  // no status report follows: end it so its campaign can complete.
  for (const row of expired) {
    if (!FIRMWARE_UPDATE_ACTIONS.has(row.action) || row.station_uuid == null) continue;
    const payload = row.payload as { requestId?: unknown } | null;
    const requestId = payload?.requestId;
    if (typeof requestId !== 'number') continue;
    try {
      await rejectFirmwareUpdate(client, {
        stationUuid: row.station_uuid,
        requestId,
        reasonCode: 'QueueExpired',
        additionalInfo: 'The station stayed offline until the queued command expired',
        actor: 'system',
        actorLabel: 'Offline command expiry',
      });
    } catch (err) {
      log.warn({ err, queueId: row.id }, 'Failed to end the expired firmware update');
    }
  }
}
