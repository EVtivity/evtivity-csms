// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';
import { sql, type SQL } from 'drizzle-orm';
import { requestHasPermission } from '../middleware/rbac.js';

/**
 * The OCPP action that carries a station security event. Its CALL and the
 * CSMS reply (CALLRESULT or CALLERROR) are logged with this action.
 */
export const SECURITY_EVENT_OCPP_ACTION = 'SecurityEventNotification';

/**
 * The OCPP actions an OCPP message log reader may not see: station security
 * events need `securityEvents:read` everywhere, the raw message log included
 * (API key scope applies, `requestHasPermission`).
 */
export async function hiddenOcppLogActions(request: FastifyRequest): Promise<string[]> {
  return (await requestHasPermission(request, 'securityEvents:read'))
    ? []
    : [SECURITY_EVENT_OCPP_ACTION];
}

/**
 * A condition that leaves out the rows of the hidden actions, or null when
 * nothing is hidden. Rows without an action (a station's reply to a CSMS
 * command) stay.
 */
export function visibleActionCondition(column: SQL, hidden: readonly string[]): SQL | null {
  if (hidden.length === 0) return null;
  const list = sql.join(
    hidden.map((a) => sql`${a}`),
    sql`, `,
  );
  return sql`(${column} IS NULL OR ${column} NOT IN (${list}))`;
}
