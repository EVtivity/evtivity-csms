// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Support case fan-out shared by the API and the worker (the driver AI
 * analysis escalates cases from the worker): the real-time event on
 * `csms_events` and `portal_events`, and the operator email and SMS of a new
 * case or a driver reply. Every function is fail-open (P9): a failed lookup or
 * publish only costs a live refresh or a notice, so it is logged at warn and
 * never rejects.
 */

import { and, asc, eq } from 'drizzle-orm';
import {
  chargingSessions,
  chargingStations,
  client,
  db,
  isSupportEnabled,
  roles,
  supportCaseSessions,
  supportCases,
  users,
} from '@evtivity/database';
import { createLogger, dispatchSystemNotification } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { ALL_TEMPLATES_DIRS } from './template-dirs.js';

const logger = createLogger('support-case-notify');

export type SupportCaseEventType =
  | 'supportCase.created'
  | 'supportCase.updated'
  | 'supportCase.newMessage';

export interface SupportCaseEventOptions {
  /**
   * False: the event reaches only the driver. A case the AI handles before
   * operators see it (`ai_assist`) is not in the operator list, counts or
   * notifications (decision E4).
   */
  toOperators?: boolean;
}

// Operators receive the event on csms_events with the same scope as
// supportCaseSiteCondition: a case at a station carries the station's siteId;
// a case without a station carries caseSiteIds, the sites of its linked
// sessions, or null when it has none or one ran at an unsited station
// (all-site operators only). The operator SSE stream (isEventVisible)
// delivers it to a site-restricted operator only when every one of those
// sites is its own. The owning driver also receives it on portal_events so
// the driver portal can refetch its case detail without polling.
//
// The portal SSE endpoint filters by driverId before broadcasting, so drivers
// only see events for cases they own. Pass driverId = null when the event
// should not reach the portal (internal operator notes, cases not linked to a
// driver).
export async function notifySupportCaseEvent(
  eventType: SupportCaseEventType,
  caseId: string,
  driverId: string | null,
  options: SupportCaseEventOptions = {},
): Promise<void> {
  try {
    await publishSupportCaseEvent(eventType, caseId, driverId, options.toOperators ?? true);
  } catch (err) {
    logger.warn({ err, eventType, caseId }, 'Support case event not published');
  }
}

async function publishSupportCaseEvent(
  eventType: SupportCaseEventType,
  caseId: string,
  driverId: string | null,
  toOperators: boolean,
): Promise<void> {
  const pubsub = getPubSub();
  if (toOperators) {
    const [scope] = await db
      .select({ stationId: supportCases.stationId, siteId: chargingStations.siteId })
      .from(supportCases)
      .leftJoin(chargingStations, eq(chargingStations.id, supportCases.stationId))
      .where(eq(supportCases.id, caseId));
    const stationId = scope?.stationId ?? null;
    const caseSiteIds = stationId == null ? await linkedSessionSiteIds(caseId) : null;
    await pubsub.publish(
      'csms_events',
      JSON.stringify({
        eventType,
        caseId,
        stationId,
        siteId: scope?.siteId ?? null,
        caseSiteIds,
      }),
    );
  }
  if (driverId != null) {
    await pubsub.publish('portal_events', JSON.stringify({ type: eventType, caseId, driverId }));
  }
}

/**
 * The distinct sites of the case's linked sessions, or null when the case has
 * no linked session or one ran at an unsited or deleted station.
 */
async function linkedSessionSiteIds(caseId: string): Promise<string[] | null> {
  const rows = await db
    .select({ siteId: chargingStations.siteId })
    .from(supportCaseSessions)
    .leftJoin(chargingSessions, eq(chargingSessions.id, supportCaseSessions.sessionId))
    .leftJoin(chargingStations, eq(chargingStations.id, chargingSessions.stationId))
    .where(eq(supportCaseSessions.caseId, caseId));
  if (rows.length === 0) return null;
  const siteIds = new Set<string>();
  for (const row of rows) {
    if (row.siteId == null) return null;
    siteIds.add(row.siteId);
  }
  return [...siteIds];
}

interface OperatorRecipient {
  userId: string;
  email: string;
  phone: string | null;
  language: string;
  timezone: string;
}

/**
 * The operator a driver case notice goes to: the active assignee, else the
 * earliest created active admin (a deterministic pick). An inactive or
 * deleted assignee falls back to the admin, so the notice is not lost.
 */
async function resolveOperatorRecipient(
  assignedTo: string | null,
): Promise<OperatorRecipient | null> {
  const recipientColumns = {
    userId: users.id,
    email: users.email,
    phone: users.phone,
    language: users.language,
    timezone: users.timezone,
  };
  if (assignedTo != null) {
    const [assignee] = await db
      .select(recipientColumns)
      .from(users)
      .where(and(eq(users.id, assignedTo), eq(users.isActive, true)));
    if (assignee != null) return assignee;
  }

  const [adminUser] = await db
    .select(recipientColumns)
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(eq(roles.name, 'admin'), eq(users.isActive, true)))
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(1);
  return adminUser ?? null;
}

/** The operator email and SMS of a new driver case (`new_case`) or a driver reply. */
export async function dispatchOperatorNotification(
  type: 'new_case' | 'driver_reply',
  caseId: string,
  caseNumber: string,
  subject: string,
  assignedTo: string | null,
): Promise<void> {
  try {
    const enabled = await isSupportEnabled();
    if (!enabled) return;

    const recipient = await resolveOperatorRecipient(assignedTo);
    if (recipient == null) return;

    const eventType =
      type === 'new_case' ? 'supportCase.NewCaseFromDriver' : 'supportCase.DriverReply';

    await dispatchSystemNotification(
      client,
      eventType,
      {
        email: recipient.email,
        phone: recipient.phone ?? undefined,
        userId: recipient.userId,
        language: recipient.language,
        timezone: recipient.timezone,
      },
      {
        caseId,
        caseNumber,
        subject,
        type,
      },
      ALL_TEMPLATES_DIRS,
    );
  } catch (err) {
    logger.warn(
      { err, caseId, type },
      'Support case operator notification failed, the request continues',
    );
  }
}
