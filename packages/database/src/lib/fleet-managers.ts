// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';

type Sql = postgres.Sql | postgres.TransactionSql;

/** A fleet user who gets the fleet's billing notices. */
export interface FleetManagerRecipient {
  userId: string;
  email: string;
  phone: string | undefined;
  firstName: string | undefined;
  lastName: string | undefined;
  language: string | undefined;
  timezone: string | undefined;
}

/** The permission a fleet user needs for the fleet billing notices. */
export const FLEET_MANAGER_NOTICE_PERMISSION = 'payments:read';

/**
 * The active fleet users (access scope fleets) assigned to the fleet who hold
 * `payments:read`, the permission that shows them the fleet's invoices and
 * credit limit.
 */
export async function loadFleetManagerRecipients(
  sql: Sql,
  fleetId: string,
): Promise<FleetManagerRecipient[]> {
  const rows = await sql<
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
    WHERE u.is_active AND u.access_scope = 'fleets'
      AND EXISTS (SELECT 1 FROM user_fleet_assignments a
        WHERE a.user_id = u.id AND a.fleet_id = ${fleetId})
      AND EXISTS (SELECT 1 FROM user_permissions p
        WHERE p.user_id = u.id AND p.permission = ${FLEET_MANAGER_NOTICE_PERMISSION})
    ORDER BY u.id
  `;
  return rows.map((u) => ({
    userId: u.id,
    email: u.email,
    phone: u.phone ?? undefined,
    firstName: u.first_name ?? undefined,
    lastName: u.last_name ?? undefined,
    language: u.language ?? undefined,
    timezone: u.timezone ?? undefined,
  }));
}

/**
 * Claims the fleet manager notice of a new fleet invoice (not a credit note,
 * not a member invoice). True for the one call that may send it.
 */
export async function claimFleetManagerInvoiceNotice(
  sql: Sql,
  invoiceId: string,
): Promise<boolean> {
  const rows = await sql`
    UPDATE invoices SET fleet_managers_notified_at = now()
    WHERE id = ${invoiceId} AND fleet_managers_notified_at IS NULL
      AND fleet_id IS NOT NULL AND NOT member_billed AND kind = 'invoice'
      AND status IN ('issued', 'paid')
    RETURNING id
  `;
  return rows.length > 0;
}
