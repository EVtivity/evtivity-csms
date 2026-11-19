// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { client } from '@evtivity/database';
import { dispatchSystemNotification } from '@evtivity/lib';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { config } from './config.js';

/** The operator notice of a change of a fleet's VAT ID or tax number. */
export const FLEET_TAX_ID_CHANGED_EVENT = 'fleet.BillingTaxIdChanged';

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

interface Recipient {
  id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  language: string | null;
  timezone: string | null;
}

export interface FleetTaxIdChange {
  fleetId: string;
  fleetName: string;
  previousTaxId: string | null;
  newTaxId: string | null;
  /** The user who changed it: told nothing, named in the notice. */
  changedByUserId: string | null;
}

/**
 * The active users with access to every site who hold payments:write or
 * fleetBilling:write, except the user who made the change. Fleet users never
 * have access to every site, so they are never recipients.
 */
async function recipients(exceptUserId: string | null): Promise<Recipient[]> {
  return client<Recipient[]>`
    SELECT u.id, u.email, u.phone, u.first_name, u.last_name, u.language, u.timezone
    FROM users u
    WHERE u.is_active AND u.has_all_site_access
      AND u.id IS DISTINCT FROM ${exceptUserId}
      AND EXISTS (SELECT 1 FROM user_permissions p
        WHERE p.user_id = u.id AND p.permission IN ('payments:write', 'fleetBilling:write'))
    ORDER BY u.id
  `;
}

async function changedByName(userId: string | null): Promise<string> {
  if (userId == null) return '';
  const rows = await client<{ first_name: string | null; last_name: string | null }[]>`
    SELECT first_name, last_name FROM users WHERE id = ${userId}
  `;
  const row = rows[0];
  if (row == null) return '';
  return [row.first_name, row.last_name].filter((p) => p != null && p !== '').join(' ');
}

/**
 * Tells the operators once per change that a fleet's VAT ID or tax number
 * changed. The new number applies to invoices issued from now on; issued
 * invoices keep the number they were issued with. Fail-open: a failed notice
 * is logged, the change stands.
 */
export async function notifyFleetTaxIdChanged(
  change: FleetTaxIdChange,
  log: Logger,
): Promise<void> {
  try {
    const [list, byName] = await Promise.all([
      recipients(change.changedByUserId),
      changedByName(change.changedByUserId),
    ]);
    const variables = {
      fleetName: change.fleetName,
      previousTaxId: change.previousTaxId ?? '',
      newTaxId: change.newTaxId ?? '',
      taxIdRemoved: change.newTaxId == null,
      changedBy: byName,
      fleetUrl: `${config.CSMS_URL.replace(/\/$/, '')}/fleets/${encodeURIComponent(change.fleetId)}?tab=billing`,
    };
    for (const user of list) {
      try {
        await dispatchSystemNotification(
          client,
          FLEET_TAX_ID_CHANGED_EVENT,
          {
            email: user.email ?? undefined,
            phone: user.phone ?? undefined,
            firstName: user.first_name ?? undefined,
            lastName: user.last_name ?? undefined,
            language: user.language ?? undefined,
            timezone: user.timezone ?? undefined,
            userId: user.id,
          },
          variables,
          ALL_TEMPLATES_DIRS,
        );
      } catch (err: unknown) {
        log.warn(
          { err, fleetId: change.fleetId, userId: user.id },
          'Fleet tax ID notice not sent to a recipient, the change stands',
        );
      }
    }
  } catch (err: unknown) {
    log.warn(
      { err, fleetId: change.fleetId },
      'Fleet tax ID notice recipients failed, the change stands',
    );
  }
}
