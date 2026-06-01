// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import Handlebars from 'handlebars';
import type postgres from 'postgres';

/**
 * Variables passed to the maintenance display template at render time. Keep
 * the contract narrow so operator-edited templates can rely on these names.
 */
export interface MaintenanceMessageVars {
  /** Display name for the operator running the site. Pulled from
   *  `company.name` setting at render time. */
  companyName: string;
  /** Human-readable site name. */
  siteName: string;
  /** Window end as ISO 8601. */
  endTime: string;
  /** Window length rounded to whole minutes. */
  durationMinutes: number;
  /** Operator-supplied reason text, may be empty. */
  reason: string;
}

// Server-side renderer cannot know the viewer's locale or timezone, so the
// default template intentionally omits {{endTime}}. The portal banner and the
// station display surface format the planned end time in the viewer's local
// time separately. Operators editing the template can still reference
// {{endTime}} if they want the raw ISO string in the body.
export const DEFAULT_MAINTENANCE_MESSAGE_TEMPLATE =
  'This site is temporarily unavailable for maintenance. {{reason}}';

interface MaintenanceEventForMessage {
  customMessage: string | null;
  reason: string | null;
  plannedStartAt: Date;
  plannedEndAt: Date;
}

async function fetchSetting(sql: postgres.Sql, key: string): Promise<string | null> {
  const rows = await sql`SELECT value FROM settings WHERE key = ${key} LIMIT 1`;
  const v: unknown = rows[0]?.['value'];
  return typeof v === 'string' ? v : null;
}

/**
 * Render the maintenance station-display message for an event. Uses
 * `event.customMessage` when set, otherwise the `maintenance.defaultMessageTemplate`
 * setting, otherwise the package default constant. Always returns a string.
 */
export async function renderMaintenanceMessage(
  sql: postgres.Sql,
  event: MaintenanceEventForMessage,
  siteName: string,
): Promise<string> {
  const custom = event.customMessage?.trim();
  let tpl: string;
  if (custom != null && custom.length > 0) {
    tpl = custom;
  } else {
    tpl =
      (await fetchSetting(sql, 'maintenance.defaultMessageTemplate')) ??
      DEFAULT_MAINTENANCE_MESSAGE_TEMPLATE;
  }
  const companyName = (await fetchSetting(sql, 'company.name')) ?? 'EVtivity';
  const compiled = Handlebars.compile(tpl, { noEscape: true });
  const durationMinutes = Math.round(
    (event.plannedEndAt.getTime() - event.plannedStartAt.getTime()) / 60_000,
  );
  return compiled({
    companyName,
    siteName,
    endTime: event.plannedEndAt.toISOString(),
    durationMinutes,
    reason: event.reason ?? '',
  } satisfies MaintenanceMessageVars);
}
