// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { OCTT_TEST_DRIVER_EMAIL } from '@evtivity/lib';
import { client } from '../config.js';
import { chargingStations } from '../schema/index.js';

/**
 * Conformance test stations (OCTT). The conformance runners create a
 * temporary station per test and mark it `charging_stations.is_conformance`.
 * While they exist, operators never see or count them: every station list,
 * count, aggregate, export, publication and target outside the conformance
 * pages applies one of the predicates below, and the rows of those stations
 * (sessions, meter values, events) are left out of aggregates the same way.
 * Lookups of one station by id need no filter.
 */

/** Station id prefix of every conformance station. */
export const CONFORMANCE_STATION_ID_PREFIX = 'OCTT-';

/**
 * Station id prefix of the CS conformance runner's stations. A CS run deletes
 * its own stations and may still be going while a CSMS run starts, so the
 * CSMS runner's wipe leaves them alone.
 */
export const CONFORMANCE_CS_STATION_ID_PREFIX = 'OCTT-CS-';

/** SQL text: station row `alias` (a charging_stations alias) is an operator station. */
export function operatorStationSql(alias: string): string {
  return `${alias}.is_conformance = false`;
}

/**
 * SQL text: `column` (a reference to a charging_stations.id value, such as
 * `cs.station_id` of a session) is not a conformance station. Null-safe: a
 * null column passes.
 */
export function operatorStationIdSql(column: string): string {
  return `NOT EXISTS (SELECT 1 FROM charging_stations conf_st WHERE conf_st.id = ${column} AND conf_st.is_conformance)`;
}

/**
 * Drizzle: the station row is an operator station. Pass the table or alias
 * the query selects from (default `chargingStations`).
 */
export function isOperatorStation(table: { isConformance: AnyPgColumn } = chargingStations): SQL {
  return eq(table.isConformance, false);
}

/**
 * Drizzle: `column` (holds a charging_stations.id) is not a conformance
 * station. Null-safe.
 */
export function inOperatorStation(column: AnyPgColumn | SQL): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM charging_stations conf_st WHERE conf_st.id = ${column} AND conf_st.is_conformance)`;
}

// Deleting conformance data. The conformance runners and the worker sweep
// (`conformance-station-sweep`) call these; nothing else deletes it.

/** Stations deleted per transaction. */
export const CONFORMANCE_DELETE_BATCH = 50;

/** Domain event aggregates keyed by the OCPP station id. */
const STATION_AGGREGATE_TYPES = ['ChargingStation', 'Connector', 'EVSE', 'Reservation'];

export interface ConformanceStationDeleteOptions {
  /**
   * Also delete the CS runner's stations (`OCTT-CS-*`). A CSMS run never
   * does: a CS run may be going next to it and deletes its own.
   */
  includeCs: boolean;
  /**
   * Delete only CSMS-run stations that are offline with no activity
   * (created, updated or heartbeat) after this time. Unset: all of them.
   */
  idleBefore?: Date;
  /** Delete only `OCTT-CS-*` stations created before this time. Unset: all of them. */
  csCreatedBefore?: Date;
}

/**
 * Deletes conformance stations with every row that references them, in
 * batches of CONFORMANCE_DELETE_BATCH stations, one transaction each.
 * Returns the number of stations deleted. Rows that do not cascade from the
 * station go first, while the station and session rows still identify them:
 * tariff segments (no session FK), CDRs (the FK does not cascade), CSRs (set
 * null), audit rows and domain events (no FK).
 */
export async function deleteConformanceStations(
  options: ConformanceStationDeleteOptions,
): Promise<number> {
  const includeCs = options.includeCs;
  const idleBefore = options.idleBefore ?? null;
  const csCreatedBefore = options.csCreatedBefore ?? null;
  const csPattern = `${CONFORMANCE_CS_STATION_ID_PREFIX}%`;
  let deleted = 0;
  for (;;) {
    const batch = await client<{ id: string; station_id: string }[]>`
      SELECT id, station_id FROM charging_stations
      WHERE is_conformance
        AND (${includeCs}::boolean OR station_id NOT LIKE ${csPattern})
        AND (
          station_id LIKE ${csPattern}
          OR ${idleBefore}::timestamptz IS NULL
          OR (NOT is_online
            AND GREATEST(created_at, updated_at, COALESCE(last_heartbeat, created_at))
              < ${idleBefore}::timestamptz)
        )
        AND (
          station_id NOT LIKE ${csPattern}
          OR ${csCreatedBefore}::timestamptz IS NULL
          OR created_at < ${csCreatedBefore}::timestamptz
        )
      ORDER BY id
      LIMIT ${CONFORMANCE_DELETE_BATCH}
    `;
    if (batch.length === 0) return deleted;
    const ids = batch.map((row) => row.id);
    const ocppIds = batch.map((row) => row.station_id);
    await client.begin(async (tx) => {
      const sessions = await tx<{ id: string; transaction_id: string | null }[]>`
        SELECT id, transaction_id FROM charging_sessions WHERE station_id = ANY(${ids})
      `;
      const sessionIds = sessions.map((row) => row.id);
      const transactionIds = sessions
        .map((row) => row.transaction_id)
        .filter((id): id is string => id != null);
      if (sessionIds.length > 0) {
        await tx`DELETE FROM session_tariff_segments WHERE session_id = ANY(${sessionIds})`;
        await tx`DELETE FROM ocpi_cdrs WHERE charging_session_id = ANY(${sessionIds})`;
        await tx`DELETE FROM session_audit_log WHERE session_id = ANY(${sessionIds})`;
      }
      if (transactionIds.length > 0) {
        await tx`
          DELETE FROM domain_events
          WHERE aggregate_type = 'Transaction' AND aggregate_id = ANY(${transactionIds})
        `;
      }
      await tx`
        DELETE FROM domain_events
        WHERE aggregate_type = ANY(${STATION_AGGREGATE_TYPES}) AND aggregate_id = ANY(${ocppIds})
      `;
      await tx`DELETE FROM authorize_attempts WHERE station_id = ANY(${ocppIds})`;
      await tx`DELETE FROM pki_csr_requests WHERE station_id = ANY(${ids})`;
      await tx`DELETE FROM station_audit_log WHERE station_id = ANY(${ids})`;
      await tx`DELETE FROM local_auth_list_audit_log WHERE station_id = ANY(${ids})`;
      // Cascades to EVSEs, connectors, sessions (meter values, transaction
      // events, payment records), logs, configurations, certificates,
      // insights, css_stations and queued offline commands.
      await tx`DELETE FROM charging_stations WHERE id = ANY(${ids})`;
    });
    deleted += batch.length;
  }
}

/**
 * Whether a CSMS conformance run may still be using the test driver: a
 * CSMS-run station is left, or the driver or one of its tokens was created
 * after `activeAfter` (a run creates the driver at its start and tokens per
 * test).
 */
export async function conformanceTestDriverInUse(activeAfter: Date): Promise<boolean> {
  const csPattern = `${CONFORMANCE_CS_STATION_ID_PREFIX}%`;
  const [row] = await client<{ in_use: boolean }[]>`
    SELECT (
      EXISTS (
        SELECT 1 FROM charging_stations
        WHERE is_conformance AND station_id NOT LIKE ${csPattern}
      )
      OR EXISTS (
        SELECT 1 FROM drivers d
        WHERE d.email = ${OCTT_TEST_DRIVER_EMAIL}
          AND (d.created_at > ${activeAfter}::timestamptz OR EXISTS (
            SELECT 1 FROM driver_tokens dt
            WHERE dt.driver_id = d.id AND dt.created_at > ${activeAfter}::timestamptz
          ))
      )
    ) AS in_use
  `;
  return row?.in_use === true;
}

export interface ConformanceDriverDeleteResult {
  /** The test driver existed and was deleted. */
  driverDeleted: boolean;
  /** Pricing groups of the test driver deleted. */
  pricingGroupsDeleted: number;
  /** Pricing groups kept because an operator session's tariff segment uses their tariffs. */
  pricingGroupsKept: number;
  /**
   * Rows outside conformance stations that referenced the test driver
   * (sessions and access logs), detached.
   */
  detachedRows: number;
}

/**
 * Deletes the conformance test driver (`OCTT_TEST_DRIVER_EMAIL`), its tokens,
 * the pricing groups only it is assigned to, and their audit and event rows,
 * in one transaction. Delete the conformance stations first: their sessions
 * reference the driver and the tariffs. A row elsewhere that still references
 * the driver (a session started with a test token at an operator station) is
 * detached instead of blocking the delete; a pricing group whose tariff an
 * operator session's tariff segment uses is kept.
 */
export async function deleteConformanceTestDriver(): Promise<ConformanceDriverDeleteResult> {
  return client.begin(async (tx) => {
    const result: ConformanceDriverDeleteResult = {
      driverDeleted: false,
      pricingGroupsDeleted: 0,
      pricingGroupsKept: 0,
      detachedRows: 0,
    };
    const drivers = await tx<{ id: string }[]>`
      SELECT id FROM drivers WHERE email = ${OCTT_TEST_DRIVER_EMAIL}
    `;
    if (drivers.length === 0) return result;
    const driverIds = drivers.map((row) => row.id);
    const tokens = await tx<{ id: string; id_token: string }[]>`
      SELECT id, id_token FROM driver_tokens WHERE driver_id = ANY(${driverIds})
    `;
    if (tokens.length > 0) {
      const tokenIds = tokens.map((row) => row.id);
      const tokenValues = tokens.map((row) => row.id_token);
      await tx`
        DELETE FROM domain_events
        WHERE aggregate_type = 'Driver' AND aggregate_id = ANY(${tokenValues})
      `;
      await tx`DELETE FROM token_audit_log WHERE token_id = ANY(${tokenIds})`;
    }
    await tx`DELETE FROM authorize_attempts WHERE matched_driver_id = ANY(${driverIds})`;
    await tx`DELETE FROM driver_audit_log WHERE driver_id = ANY(${driverIds})`;

    const groups = await tx<{ id: string; in_use: boolean }[]>`
      SELECT pg.id,
        EXISTS (
          SELECT 1 FROM session_tariff_segments sts
          JOIN tariffs t ON t.id = sts.tariff_id
          WHERE t.pricing_group_id = pg.id
        ) AS in_use
      FROM pricing_groups pg
      WHERE pg.id IN (
          SELECT pricing_group_id FROM pricing_group_drivers WHERE driver_id = ANY(${driverIds})
        )
        AND NOT pg.is_default
        AND NOT EXISTS (
          SELECT 1 FROM pricing_group_drivers o
          WHERE o.pricing_group_id = pg.id AND o.driver_id <> ALL(${driverIds})
        )
        AND NOT EXISTS (SELECT 1 FROM pricing_group_sites x WHERE x.pricing_group_id = pg.id)
        AND NOT EXISTS (SELECT 1 FROM pricing_group_stations x WHERE x.pricing_group_id = pg.id)
        AND NOT EXISTS (SELECT 1 FROM pricing_group_fleets x WHERE x.pricing_group_id = pg.id)
    `;
    const deletable = groups.filter((row) => !row.in_use).map((row) => row.id);
    result.pricingGroupsKept = groups.length - deletable.length;

    // Reservations and support cases keep their own writers: one of those
    // still naming the driver fails the delete, which is logged and retried.
    const detached = [
      await tx`UPDATE charging_sessions SET driver_id = NULL WHERE driver_id = ANY(${driverIds})`,
      await tx`UPDATE access_logs SET driver_id = NULL WHERE driver_id = ANY(${driverIds})`,
    ];
    result.detachedRows = detached.reduce((sum, rows) => sum + rows.count, 0);

    if (deletable.length > 0) {
      await tx`
        UPDATE charging_sessions SET tariff_id = NULL
        WHERE tariff_id IN (SELECT id FROM tariffs WHERE pricing_group_id = ANY(${deletable}))
      `;
      // Cascades to the tariffs and the group assignments.
      const removed = await tx`DELETE FROM pricing_groups WHERE id = ANY(${deletable})`;
      result.pricingGroupsDeleted = removed.count;
    }
    // Cascades to the tokens (and their PnC contracts), favorites, vehicles,
    // notification preferences and the other per-driver rows.
    const removedDrivers = await tx`DELETE FROM drivers WHERE id = ANY(${driverIds})`;
    result.driverDeleted = removedDrivers.count > 0;
    return result;
  });
}
