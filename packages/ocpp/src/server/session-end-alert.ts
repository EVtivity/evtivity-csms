// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import type { Logger } from '@evtivity/lib';
import { ALL_TEMPLATES_DIRS, dispatchSystemNotification } from './notification-dispatcher.js';

/** System event sent to operators when the CSMS gives up ending a session. */
export const SESSION_END_FAILED_EVENT = 'session.EndRequestFailed';

/** Operators with this permission (and access to the session's site) get the alert. */
export const SESSION_END_FAILED_PERMISSION = 'sessions:write';

/** A timestamp as an ISO string (formatted per recipient by the dispatcher), '' when unset. */
function isoOrEmpty(value: unknown): string {
  if (value == null) return '';
  return new Date(value as Date | string).toISOString();
}

/**
 * Alerts the operators who manage a session that the CSMS gave up ending it
 * (stopped reason EndRequestFailed): every active user with
 * SESSION_END_FAILED_PERMISSION and access to the session's site gets
 * SESSION_END_FAILED_EVENT by email and SMS (their SMS opt-out and the
 * system event toggle apply). The caller sends it once, from the call that
 * faulted the session. Fail-open (P9): an error is logged at warn and never
 * thrown.
 */
export async function notifySessionEndFailed(
  sql: postgres.Sql,
  sessionId: string,
  logger: Logger,
): Promise<void> {
  try {
    const [session] = await sql`
      SELECT cs.transaction_id, cs.started_at, cs.ended_at, cs.end_request_reason,
        cs.end_attempts, st.station_id AS station_ocpp_id, st.site_id, si.name AS site_name
      FROM charging_sessions cs
      JOIN charging_stations st ON st.id = cs.station_id
      LEFT JOIN sites si ON si.id = st.site_id
      WHERE cs.id = ${sessionId}
    `;
    if (session == null) return;
    const siteId = (session['site_id'] as string | null) ?? null;
    const recipients = await sql`
      SELECT u.id, u.email, u.phone, u.first_name, u.last_name, u.language, u.timezone
      FROM users u
      WHERE u.is_active
        AND EXISTS (SELECT 1 FROM user_permissions p
          WHERE p.user_id = u.id AND p.permission = ${SESSION_END_FAILED_PERMISSION})
        AND (u.has_all_site_access
          OR EXISTS (SELECT 1 FROM user_site_assignments a
            WHERE a.user_id = u.id AND a.site_id = ${siteId}))
      ORDER BY u.id
    `;
    if (recipients.length === 0) {
      logger.warn({ sessionId }, 'No operator to alert about a session whose end failed');
      return;
    }
    const variables = {
      sessionId,
      stationId: session['station_ocpp_id'] as string,
      siteName: (session['site_name'] as string | null) ?? '',
      transactionId: (session['transaction_id'] as string | null) ?? '',
      endRequestReason: (session['end_request_reason'] as string | null) ?? '',
      attempts: Number(session['end_attempts']),
      startedAt: isoOrEmpty(session['started_at']),
      endedAt: isoOrEmpty(session['ended_at']),
    };
    for (const user of recipients) {
      await dispatchSystemNotification(
        sql,
        SESSION_END_FAILED_EVENT,
        {
          email: user['email'] as string,
          phone: (user['phone'] as string | null) ?? undefined,
          firstName: (user['first_name'] as string | null) ?? undefined,
          lastName: (user['last_name'] as string | null) ?? undefined,
          language: user['language'] as string,
          timezone: user['timezone'] as string,
          userId: user['id'] as string,
        },
        variables,
        ALL_TEMPLATES_DIRS,
      );
    }
  } catch (err: unknown) {
    logger.warn({ err, sessionId }, 'Failed to alert operators about a session whose end failed');
  }
}
