// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  claimFleetCreditLimitNotice,
  client,
  loadFleetBillingContacts,
  type FleetCreditCheck,
} from '@evtivity/database';
import { dispatchSystemNotification, notificationMoney } from '@evtivity/lib';
import type { ServiceLogger } from '@evtivity/lib';

export const FLEET_CREDIT_LIMIT_WARNING_EVENT = 'fleet.CreditLimitWarning';
export const FLEET_CREDIT_LIMIT_REACHED_EVENT = 'fleet.CreditLimitReached';

/** Operators with this permission manage fleets and get the credit limit notices. */
export const FLEET_CREDIT_NOTICE_PERMISSION = 'fleets:write';

export interface FleetCreditNoticeDeps {
  /** Notification template directories of the calling process. */
  templatesDirs: string[];
}

interface NoticeRecipient {
  email: string;
  phone?: string | undefined;
  firstName?: string | undefined;
  lastName?: string | undefined;
  language?: string | undefined;
  timezone?: string | undefined;
  userId?: string | undefined;
}

/** Active operators with FLEET_CREDIT_NOTICE_PERMISSION (fleets are not site-scoped). */
async function loadFleetOperators(): Promise<NoticeRecipient[]> {
  const rows = await client<
    Array<{
      id: string;
      email: string;
      phone: string | null;
      first_name: string | null;
      last_name: string | null;
      language: string | null;
      timezone: string | null;
    }>
  >`
    SELECT u.id, u.email, u.phone, u.first_name, u.last_name, u.language, u.timezone
    FROM users u
    WHERE u.is_active
      AND EXISTS (SELECT 1 FROM user_permissions p
        WHERE p.user_id = u.id AND p.permission = ${FLEET_CREDIT_NOTICE_PERMISSION})
    ORDER BY u.id
  `;
  return rows.map((u) => ({
    email: u.email,
    phone: u.phone ?? undefined,
    firstName: u.first_name ?? undefined,
    lastName: u.last_name ?? undefined,
    language: u.language ?? undefined,
    timezone: u.timezone ?? undefined,
    userId: u.id,
  }));
}

/**
 * The recipients of a fleet credit limit notice: the fleet's billing contacts
 * (in the fleet's invoice language) and, for `reached` (an operator system
 * event), the operators who manage fleets. A warning goes to the operators
 * only when the fleet has no billing contact, so it always reaches someone.
 */
async function noticeRecipients(
  fleetId: string,
  kind: 'warning' | 'reached',
): Promise<NoticeRecipient[]> {
  const billing = await loadFleetBillingContacts(client, fleetId);
  const contacts: NoticeRecipient[] = billing.emails.map((email) => ({
    email,
    language: billing.language ?? undefined,
  }));
  if (kind === 'warning' && contacts.length > 0) return contacts;
  const operators = await loadFleetOperators();
  const seen = new Set(contacts.map((c) => c.email.toLowerCase()));
  return [...contacts, ...operators.filter((o) => !seen.has(o.email.toLowerCase()))];
}

/**
 * Sends the fleet credit limit notice a start check calls for, once per fleet,
 * calendar month and kind (the claim in `fleet_credit_limit_notices`, P7):
 * `fleet.CreditLimitReached` when the exposure is at or above the limit,
 * `fleet.CreditLimitWarning` when it is at or above the warning percent.
 * Called by the OCPP payment gate and the portal start after their check.
 * Returns the notice sent, or null. Fail-open (P9): the start decision is
 * made; a failure is logged at warn and returns null.
 */
export async function dispatchFleetCreditLimitNotices(
  check: FleetCreditCheck,
  deps: FleetCreditNoticeDeps,
  log: ServiceLogger,
): Promise<'warning' | 'reached' | null> {
  if (check.level === 'ok') return null;
  const kind = check.level;
  try {
    if (!(await claimFleetCreditLimitNotice(client, check, kind))) return null;
    const recipients = await noticeRecipients(check.fleetId, kind);
    if (recipients.length === 0) {
      log.warn({ fleetId: check.fleetId, kind }, 'No recipient for the fleet credit limit notice');
      return null;
    }
    const { currency } = check.exposure;
    const variables = {
      fleetName: check.fleetName,
      limitFormatted: notificationMoney(check.limitCents, currency),
      exposureFormatted: notificationMoney(check.exposure.totalCents, currency),
      limitCents: check.limitCents,
      exposureCents: check.exposure.totalCents,
      warningPercent: check.warningPercent,
      currency,
    };
    const eventType =
      kind === 'reached' ? FLEET_CREDIT_LIMIT_REACHED_EVENT : FLEET_CREDIT_LIMIT_WARNING_EVENT;
    for (const recipient of recipients) {
      await dispatchSystemNotification(client, eventType, recipient, variables, deps.templatesDirs);
    }
    return kind;
  } catch (err) {
    log.warn({ err, fleetId: check.fleetId, kind }, 'Fleet credit limit notice failed; continuing');
    return null;
  }
}
