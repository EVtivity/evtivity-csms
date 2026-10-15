// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from 'pino';
import type postgres from 'postgres';
import { client } from '@evtivity/database';

/**
 * A charging profile push (or template clear) runs in the API process that
 * started it. A push still `active` with no station result for this long was
 * cut off by an API restart: a running push finishes a station at least every
 * two command timeouts (about 70 s), so the window leaves wide room.
 */
export const STUCK_PUSH_MINUTES = 15;

export interface ChargingProfilePushSweepResult {
  pushes: number;
  stations: number;
}

/**
 * Ends the pushes an API restart cut off: their `pending` stations go
 * `failed` with "Push interrupted" and the push goes `completed`. Status
 * guards keep a station result or a completed push as it is (P5), so a rerun
 * or a late result changes nothing.
 */
export async function sweepStuckChargingProfilePushes(
  sql: postgres.Sql,
  stuckMinutes: number = STUCK_PUSH_MINUTES,
): Promise<ChargingProfilePushSweepResult> {
  const [row] = await sql<{ pushes: number; stations: number }[]>`
    WITH stuck AS (
      SELECT p.id FROM charging_profile_pushes p
      WHERE p.status = 'active'
        AND p.updated_at < now() - make_interval(mins => ${stuckMinutes})
        AND NOT EXISTS (
          SELECT 1 FROM charging_profile_push_stations s
          WHERE s.push_id = p.id
            AND s.status <> 'pending'
            AND s.updated_at >= now() - make_interval(mins => ${stuckMinutes})
        )
    ),
    failed AS (
      UPDATE charging_profile_push_stations
      SET status = 'failed', error_info = 'Push interrupted', updated_at = now()
      WHERE push_id IN (SELECT id FROM stuck) AND status = 'pending'
      RETURNING id
    ),
    done AS (
      UPDATE charging_profile_pushes
      SET status = 'completed', updated_at = now()
      WHERE id IN (SELECT id FROM stuck) AND status = 'active'
      RETURNING id
    )
    SELECT (SELECT count(*) FROM done)::int AS pushes, (SELECT count(*) FROM failed)::int AS stations
  `;
  return { pushes: row?.pushes ?? 0, stations: row?.stations ?? 0 };
}

/**
 * A configuration template push sends one command per variable to each station
 * (up to about 35 s each), so a station of a large template can take many
 * minutes without a result: its window is longer.
 */
export const STUCK_CONFIG_PUSH_MINUTES = 60;

/**
 * Ends the configuration template pushes an API restart cut off, the same way
 * as the charging profile pushes: `pending` stations go `failed` with "Push
 * interrupted" and the push goes `completed`, status guarded (P5).
 */
export async function sweepStuckConfigTemplatePushes(
  sql: postgres.Sql,
  stuckMinutes: number = STUCK_CONFIG_PUSH_MINUTES,
): Promise<ChargingProfilePushSweepResult> {
  const [row] = await sql<{ pushes: number; stations: number }[]>`
    WITH stuck AS (
      SELECT p.id FROM config_template_pushes p
      WHERE p.status = 'active'
        AND p.updated_at < now() - make_interval(mins => ${stuckMinutes})
        AND NOT EXISTS (
          SELECT 1 FROM config_template_push_stations s
          WHERE s.push_id = p.id
            AND s.status <> 'pending'
            AND s.updated_at >= now() - make_interval(mins => ${stuckMinutes})
        )
    ),
    failed AS (
      UPDATE config_template_push_stations
      SET status = 'failed', error_info = 'Push interrupted', updated_at = now()
      WHERE push_id IN (SELECT id FROM stuck) AND status = 'pending'
      RETURNING id
    ),
    done AS (
      UPDATE config_template_pushes
      SET status = 'completed', updated_at = now()
      WHERE id IN (SELECT id FROM stuck) AND status = 'active'
      RETURNING id
    )
    SELECT (SELECT count(*) FROM done)::int AS pushes, (SELECT count(*) FROM failed)::int AS stations
  `;
  return { pushes: row?.pushes ?? 0, stations: row?.stations ?? 0 };
}

export async function chargingProfilePushSweepHandler(log: Logger): Promise<void> {
  const result = await sweepStuckChargingProfilePushes(client);
  if (result.pushes > 0) {
    log.warn(result, 'Ended charging profile pushes an API restart interrupted');
  }
  const config = await sweepStuckConfigTemplatePushes(client);
  if (config.pushes > 0) {
    log.warn(config, 'Ended configuration template pushes an API restart interrupted');
  }
}
