// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// EVSEs that left an OCPI location (`ocpi_removed_evses`). OCPI 2.3.0 8.1:
// an EVSE is never deleted for partners; a CPO sends it with status REMOVED.
// When an EVSE row is deleted, or its station moves to another site, the
// location it left keeps serving it as REMOVED (GET and push) for
// OCPI_REMOVED_EVSE_RETENTION_DAYS. The live `evses` table stays the only
// source of live EVSEs: a row here is ignored while the EVSE is live at that
// site again.

import { and, gte, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../config.js';
import { ocpiRemovedEvses } from '../schema/ocpi.js';

/** How long a removed EVSE is still served as REMOVED. */
export const OCPI_REMOVED_EVSE_RETENTION_DAYS = 90;

/** A connector of a removed EVSE, as it was when the EVSE was removed. */
export interface RemovedEvseConnector {
  id: string;
  connectorId: number;
  connectorType: string | null;
  maxPowerKw: string | null;
  maxCurrentAmps: number | null;
}

export interface RemovedOcpiEvse {
  evseUid: string;
  siteId: string;
  stationOcppId: string;
  evseNumber: number;
  connectors: RemovedEvseConnector[];
  removedAt: Date;
}

type Executor = Pick<typeof db, 'execute'>;

function retentionStart(now: Date): Date {
  return new Date(now.getTime() - OCPI_REMOVED_EVSE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Records EVSEs as removed from a site, with a snapshot of their station's
 * OCPP id, their number, and their connectors. Call it before the EVSE rows
 * are deleted (in the same transaction) or, for a station that moved, with
 * the site it left. Recording again refreshes the snapshot and the time.
 */
export async function recordRemovedOcpiEvses(
  siteId: string,
  evseIds: readonly string[],
  executor: Executor = db,
): Promise<void> {
  if (evseIds.length === 0) return;
  await executor.execute(sql`
    INSERT INTO ocpi_removed_evses (evse_uid, site_id, station_ocpp_id, evse_number, connectors, removed_at)
    SELECT e.id, ${siteId}, cs.station_id, e.evse_id,
      COALESCE(
        (SELECT jsonb_agg(jsonb_build_object(
            'id', c.id,
            'connectorId', c.connector_id,
            'connectorType', c.connector_type,
            'maxPowerKw', c.max_power_kw,
            'maxCurrentAmps', c.max_current_amps
          ) ORDER BY c.connector_id)
         FROM connectors c WHERE c.evse_id = e.id),
        '[]'::jsonb),
      now()
    FROM evses e
    JOIN charging_stations cs ON cs.id = e.station_id
    WHERE e.id IN ${[...evseIds]}
    ON CONFLICT (evse_uid, site_id) DO UPDATE SET
      station_ocpp_id = EXCLUDED.station_ocpp_id,
      evse_number = EXCLUDED.evse_number,
      connectors = EXCLUDED.connectors,
      removed_at = EXCLUDED.removed_at
  `);
}

/**
 * The removed EVSEs of the sites within the retention period, except those
 * live at the same site again (a station moved back).
 */
export async function removedOcpiEvses(
  siteIds: readonly string[],
  now: Date = new Date(),
): Promise<RemovedOcpiEvse[]> {
  if (siteIds.length === 0) return [];
  const rows = await db
    .select()
    .from(ocpiRemovedEvses)
    .where(
      and(
        inArray(ocpiRemovedEvses.siteId, [...siteIds]),
        gte(ocpiRemovedEvses.removedAt, retentionStart(now)),
        sql`NOT EXISTS (
          SELECT 1 FROM evses e JOIN charging_stations cs ON cs.id = e.station_id
          WHERE e.id = ${ocpiRemovedEvses.evseUid} AND cs.site_id = ${ocpiRemovedEvses.siteId}
        )`,
      ),
    );
  return rows.map((r) => ({
    ...r,
    connectors: r.connectors as RemovedEvseConnector[],
  }));
}

/** Deletes removed EVSEs past the retention period. */
export async function pruneRemovedOcpiEvses(now: Date = new Date()): Promise<void> {
  await db.delete(ocpiRemovedEvses).where(lt(ocpiRemovedEvses.removedAt, retentionStart(now)));
}
