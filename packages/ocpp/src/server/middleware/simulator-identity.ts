// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { IncomingMessage } from 'node:http';
import type postgres from 'postgres';
import type { Logger } from '@evtivity/lib';
import { SIMULATOR_CONNECTION_HEADER, SIMULATOR_CONNECTION_HEADER_VALUE } from '@evtivity/lib';
import { stationAuditLog, writeAudit } from '@evtivity/database';
import { logConnectionEvent } from './connection-log.js';

// A station flagged `is_simulator` is driven by the paired simulator
// (`css_stations`). When a real station uses the same identity, both keep
// taking the connection from each other. This module tells them apart on
// every successful connection to a flagged station:
//
// - The simulator sends SIMULATOR_CONNECTION_HEADER. Its first such
//   connection sets `css_stations.marker_seen_at`: proof that the simulator
//   of this release owns the identity.
// - A connection without the marker that authenticated (security profile
//   1-3) is a real station, unless an enabled pairing never showed the marker
//   (a simulator from an older release, during an upgrade). A real station
//   self-heals the row: flag cleared, pairing disabled.
// - Everything else (profile 0, which proves nothing, or the older simulator
//   case) records a conflict that the operator confirms on the station page.

export interface SimulatorPairing {
  enabled: boolean;
  markerSeenAt: Date | null;
}

export interface SimulatorConnection {
  stationDbId: string;
  stationId: string;
  /** The profile the station authenticated with. */
  securityProfile: number;
  markerPresent: boolean;
  pairing: SimulatorPairing | null;
  remoteAddress: string | null;
}

export type SimulatorConnectionKind =
  | { kind: 'simulator' }
  | { kind: 'real_station' }
  | { kind: 'conflict'; reason: 'unauthenticated_profile' | 'simulator_not_verified' };

export function hasSimulatorMarker(req: IncomingMessage): boolean {
  return req.headers[SIMULATOR_CONNECTION_HEADER] === SIMULATOR_CONNECTION_HEADER_VALUE;
}

export function classifySimulatorConnection(conn: SimulatorConnection): SimulatorConnectionKind {
  if (conn.markerPresent) return { kind: 'simulator' };
  if (conn.securityProfile === 0) return { kind: 'conflict', reason: 'unauthenticated_profile' };
  if (conn.pairing != null && conn.pairing.enabled && conn.pairing.markerSeenAt == null) {
    return { kind: 'conflict', reason: 'simulator_not_verified' };
  }
  return { kind: 'real_station' };
}

/**
 * Acts on a successful connection to a simulator-flagged station. Fail-open:
 * every failure is logged and the connection is accepted as authenticated.
 */
export async function reconcileSimulatorIdentity(
  sql: postgres.Sql,
  conn: SimulatorConnection,
  logger: Logger,
): Promise<void> {
  const result = classifySimulatorConnection(conn);
  try {
    if (result.kind === 'simulator') {
      await recordSimulatorMarker(sql, conn);
    } else if (result.kind === 'real_station') {
      await selfHeal(sql, conn, logger);
    } else {
      await recordConflict(sql, conn, result.reason, logger);
    }
  } catch (err) {
    logger.warn(
      { err, stationId: conn.stationId, outcome: result.kind },
      'Simulator identity check failed; connection accepted',
    );
  }
}

async function recordSimulatorMarker(sql: postgres.Sql, conn: SimulatorConnection): Promise<void> {
  if (conn.pairing == null || conn.pairing.markerSeenAt != null) return;
  const marked = await sql`
    UPDATE css_stations SET marker_seen_at = now()
    WHERE station_id = ${conn.stationId} AND marker_seen_at IS NULL
    RETURNING id
  `;
  if (marked.length === 0) return;
  // Conflicts recorded before the first marker came from a simulator of an
  // older release, not from a real station.
  await sql`
    UPDATE charging_stations SET simulator_conflict_at = NULL
    WHERE id = ${conn.stationDbId} AND simulator_conflict_at IS NOT NULL
  `;
}

async function selfHeal(
  sql: postgres.Sql,
  conn: SimulatorConnection,
  logger: Logger,
): Promise<void> {
  const healed = await sql.begin(async (tx) => {
    const cleared = await tx`
      UPDATE charging_stations
      SET is_simulator = false, simulator_conflict_at = NULL, updated_at = now()
      WHERE id = ${conn.stationDbId} AND is_simulator = true
      RETURNING id
    `;
    if (cleared.length === 0) return false;
    await tx`
      UPDATE css_stations SET enabled = false, updated_at = now()
      WHERE station_id = ${conn.stationId}
    `;
    return true;
  });
  // Another connection or the operator cleared the flag first.
  if (!healed) return;

  const simulatorWasEnabled = conn.pairing?.enabled === true;
  logger.warn(
    {
      stationId: conn.stationId,
      securityProfile: conn.securityProfile,
      remoteAddress: conn.remoteAddress,
      simulatorDisabled: simulatorWasEnabled,
    },
    'A real station authenticated as a simulator-flagged station; cleared the simulator flag',
  );
  await logConnectionEvent(
    sql,
    conn.stationDbId,
    'simulator_self_healed',
    conn.remoteAddress,
    { securityProfile: conn.securityProfile, simulatorDisabled: simulatorWasEnabled },
    logger,
  );
  await writeAudit(
    { table: stationAuditLog, idColumn: 'station_id' },
    {
      entityId: conn.stationDbId,
      entityIdSnapshot: conn.stationDbId,
      action: 'simulator_toggled',
      actor: 'ocpp',
      actorLabel: 'Connection authentication',
      before: { isSimulator: true, simulatorEnabled: simulatorWasEnabled },
      after: { isSimulator: false, simulatorEnabled: false },
      notes: `A station without the simulator marker authenticated with security profile ${String(conn.securityProfile)}`,
    },
    undefined,
    logger,
  );
}

async function recordConflict(
  sql: postgres.Sql,
  conn: SimulatorConnection,
  reason: 'unauthenticated_profile' | 'simulator_not_verified',
  logger: Logger,
): Promise<void> {
  await sql`
    UPDATE charging_stations SET simulator_conflict_at = now()
    WHERE id = ${conn.stationDbId} AND is_simulator = true
  `;
  logger.warn(
    {
      stationId: conn.stationId,
      securityProfile: conn.securityProfile,
      remoteAddress: conn.remoteAddress,
      reason,
    },
    'A connection without the simulator marker reached a simulator-flagged station',
  );
  await logConnectionEvent(
    sql,
    conn.stationDbId,
    'simulator_conflict',
    conn.remoteAddress,
    { securityProfile: conn.securityProfile, reason },
    logger,
  );
}
