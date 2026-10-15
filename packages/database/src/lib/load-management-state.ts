// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';

// Station replies that change what the load management cycle sends next. The
// cycle (`runLoadManagementCycle`, @evtivity/services) reads the state from
// `site_load_management.applied_allocations` and carries it forward; these are
// the only other writers of that column and of `applied_at`.

export type LoadManagementRateUnit = 'A' | 'W';

/**
 * The station's load management profile may be gone (an accepted
 * ClearChargingProfile, a reboot): null `applied_at` of its site so the next
 * cycle sends the limits again instead of waiting for the refresh interval.
 * Only for a station on a circuit of a site with load management on. Keyed by
 * the station's OCPP identity, one statement. Returns true when a site was
 * marked.
 */
export async function markLoadManagementStale(
  sql: postgres.Sql,
  stationOcppId: string,
): Promise<boolean> {
  const result = await sql`
    UPDATE site_load_management slm
    SET applied_at = NULL
    FROM charging_stations cs
    WHERE cs.station_id = ${stationOcppId}
      AND cs.circuit_id IS NOT NULL
      AND slm.site_id = cs.site_id
      AND slm.is_enabled = true
      AND slm.applied_at IS NOT NULL
  `;
  return result.count > 0;
}

/**
 * Records the station's answer to its load management profile in its entry of
 * `applied_allocations`:
 *
 * - Not accepted (Rejected, or a CALLERROR): `limitPending` is set and the unit
 *   joins `rejectedUnits`. The cycle then treats the station as a fixed load
 *   and sends the limit in the other unit. `applied_at` is nulled only when the
 *   unit is new, so the retry goes out on the next cycle and a station that
 *   rejects both units is asked again only at the refresh interval.
 * - Accepted: `limitPending` is removed and the unit leaves `rejectedUnits`.
 *
 * Writes nothing when the station has no entry or the state is unchanged.
 * Returns true when the state changed.
 */
export async function recordLoadManagementProfileReply(
  sql: postgres.Sql,
  stationUuid: string,
  reply: { accepted: boolean; unit: LoadManagementRateUnit },
): Promise<boolean> {
  const unit = reply.unit;
  if (reply.accepted) {
    const result = await sql`
      UPDATE site_load_management slm
      SET applied_allocations = (
        SELECT jsonb_agg(
          CASE WHEN t.e ->> 'stationDbId' = ${stationUuid}
            THEN (t.e - 'limitPending') || jsonb_build_object(
              'rejectedUnits',
              COALESCE(
                (
                  SELECT jsonb_agg(u.v)
                  FROM jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(t.e -> 'rejectedUnits') = 'array'
                      THEN t.e -> 'rejectedUnits' ELSE '[]'::jsonb END
                  ) AS u(v)
                  WHERE u.v <> ${unit}
                ),
                '[]'::jsonb
              )
            )
            ELSE t.e
          END
          ORDER BY t.ord
        )
        FROM jsonb_array_elements(slm.applied_allocations) WITH ORDINALITY AS t(e, ord)
      )
      WHERE slm.site_id = (SELECT site_id FROM charging_stations WHERE id = ${stationUuid})
        AND jsonb_typeof(slm.applied_allocations) = 'array'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(slm.applied_allocations) AS x(e)
          WHERE x.e ->> 'stationDbId' = ${stationUuid}
            AND (
              x.e -> 'limitPending' = 'true'::jsonb
              OR COALESCE(x.e -> 'rejectedUnits', '[]'::jsonb) ? ${unit}
            )
        )
    `;
    return result.count > 0;
  }

  const result = await sql`
    UPDATE site_load_management slm
    SET applied_allocations = (
          SELECT jsonb_agg(
            CASE WHEN t.e ->> 'stationDbId' = ${stationUuid}
              THEN t.e || jsonb_build_object(
                'limitPending', true,
                'rejectedUnits',
                (
                  SELECT jsonb_agg(DISTINCT u.v)
                  FROM jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(t.e -> 'rejectedUnits') = 'array'
                      THEN t.e -> 'rejectedUnits' ELSE '[]'::jsonb END
                    || jsonb_build_array(${unit}::text)
                  ) AS u(v)
                )
              )
              ELSE t.e
            END
            ORDER BY t.ord
          )
          FROM jsonb_array_elements(slm.applied_allocations) WITH ORDINALITY AS t(e, ord)
        ),
        applied_at = CASE
          WHEN EXISTS (
            SELECT 1 FROM jsonb_array_elements(slm.applied_allocations) AS x(e)
            WHERE x.e ->> 'stationDbId' = ${stationUuid}
              AND NOT (COALESCE(x.e -> 'rejectedUnits', '[]'::jsonb) ? ${unit})
          ) THEN NULL
          ELSE slm.applied_at
        END
    WHERE slm.site_id = (SELECT site_id FROM charging_stations WHERE id = ${stationUuid})
      AND slm.is_enabled = true
      AND jsonb_typeof(slm.applied_allocations) = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(slm.applied_allocations) AS x(e)
        WHERE x.e ->> 'stationDbId' = ${stationUuid}
          AND (
            x.e -> 'limitPending' IS DISTINCT FROM 'true'::jsonb
            OR NOT (COALESCE(x.e -> 'rejectedUnits', '[]'::jsonb) ? ${unit})
          )
      )
  `;
  return result.count > 0;
}
