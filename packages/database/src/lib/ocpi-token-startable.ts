// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The session start check of `resolveOcpiTokenOwner` (ocpi-token-owner.ts), on
// the caller's connection and with no other runtime import, so the OCPP
// projection (and its tests on a mocked client) can run it.

import type postgres from 'postgres';

/**
 * How long a partner's START_SESSION binds the token it carries to the station
 * it was sent to: the station's Authorize and its transaction start arrive
 * well within it.
 */
export const OCPI_START_CONTEXT_MINUTES = 15;

/**
 * Whether a token presented at a station starts a roaming session: the owner
 * `resolveOcpiTokenOwner` finds may charge. One statement (it runs on the
 * session start path): the matching START_SESSION's token validity when a
 * command binds the token, else exactly one connected partner holding it as
 * a valid token. A row comes back only when startable.
 */
export async function isStartableOcpiToken(
  input: { stationOcppId: string; tokenUid: string; remoteStartId?: number | null },
  sql: postgres.Sql,
): Promise<boolean> {
  const remoteStartId = input.remoteStartId ?? null;
  const rows = await sql`
    SELECT 1 AS startable
    WHERE COALESCE(
      (SELECT COALESCE(t.is_valid, (c.token_data->>'valid') IS DISTINCT FROM 'false')
       FROM ocpi_commands c
       JOIN ocpi_partners p ON p.id = c.partner_id AND p.status = 'connected'
       LEFT JOIN ocpi_external_tokens t ON t.partner_id = c.partner_id AND t.uid = c.token_uid
       WHERE c.command_type = 'START_SESSION'
         AND c.station_id = ${input.stationOcppId}
         AND c.token_uid = ${input.tokenUid}
         AND c.charging_session_id IS NULL
         AND c.created_at > now() - make_interval(mins => ${OCPI_START_CONTEXT_MINUTES})
       ORDER BY (c.remote_start_id IS NOT DISTINCT FROM ${remoteStartId}::integer) DESC,
                c.created_at DESC
       LIMIT 1),
      (SELECT count(*) = 1
       FROM ocpi_external_tokens t
       JOIN ocpi_partners p ON p.id = t.partner_id AND p.status = 'connected'
       WHERE t.uid = ${input.tokenUid} AND t.is_valid AND t.whitelist <> 'NEVER')
    )
  `;
  return rows.length > 0;
}
