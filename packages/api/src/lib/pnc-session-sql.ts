// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// What makes a session a Plug and Charge session: its token is an eMAID
// token that a Plug and Charge contract belongs to. The session detail route
// (the contract it shows) and the dashboard Plug and Charge chart use it.

import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/** The OCPP IdToken type of a Plug and Charge contract token. */
export const PNC_TOKEN_TYPE = 'eMAID';

/** SQL: the token behind `tokenIdColumn` (a driver_tokens.id) is a Plug and Charge contract token. */
export function isPncSessionToken(tokenIdColumn: AnyPgColumn): SQL {
  return sql`EXISTS (SELECT 1 FROM driver_tokens pnc_dt
    JOIN pnc_contracts pnc_pc ON pnc_pc.driver_token_id = pnc_dt.id
    WHERE pnc_dt.id = ${tokenIdColumn} AND pnc_dt.token_type = ${PNC_TOKEN_TYPE})`;
}
