// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, type SQL } from 'drizzle-orm';

/**
 * The SQL form of a driver token value compared with vehicle ids, the mirror
 * of `tokenVehicleIdCandidates` (@evtivity/lib/vehicle-id): the value without
 * a `VID:` prefix, uppercase, and a MAC address without its separators. Equal
 * to a stored (normalized) vehicle VIN or EVCCID exactly when one of the
 * candidates is. Migration 0479 counts collisions with the same expression.
 */
export function tokenVehicleIdKeySql(column: SQL): SQL {
  return sql`(
    CASE
      WHEN upper(btrim(regexp_replace(btrim(${column}), '^vid:', '', 'i')))
        ~ '^([0-9A-F]{12}|[0-9A-F]{2}(:[0-9A-F]{2}){5}|[0-9A-F]{2}(-[0-9A-F]{2}){5}|[0-9A-F]{4}([.][0-9A-F]{4}){2})$'
        THEN regexp_replace(upper(btrim(regexp_replace(btrim(${column}), '^vid:', '', 'i'))), '[:.-]', '', 'g')
      ELSE upper(btrim(regexp_replace(btrim(${column}), '^vid:', '', 'i')))
    END
  )`;
}
