// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';
import type { Permission } from '@evtivity/lib';
import type { AuditEntityType } from '@evtivity/database';
import { requestHasPermission } from '../middleware/rbac.js';

/**
 * The read permission an audit entity type needs on top of `audit:read`:
 * its history holds what the resource's own routes show only with that permission. A type not listed follows
 * `audit:read` and the site scope alone. AI conversation rows are further
 * limited to the conversation's owner in the audit routes
 * (`auditOwnerCondition`), as the conversation routes are.
 */
export const AUDIT_READ_PERMISSION: Readonly<Partial<Record<AuditEntityType, Permission>>> = {
  setting: 'settings.system:read',
  user: 'users:read',
  role: 'users:read',
  api_key: 'users:read',
  payment: 'payments:read',
  invoice: 'payments:read',
  driver: 'drivers:read',
  token: 'drivers:read',
  // Fleet billing rows hold the credit limit
  // and billing mode (payments:read on the fleet routes), vehicle rows the VIN
  // and Autocharge ids (drivers:read), schedule rows the recipients.
  fleet: 'payments:read',
  vehicle: 'drivers:read',
  report_schedule: 'reports:read',
};

/**
 * The audit entity types of `types` the request may read: each needs its
 * resource read permission (`requestHasPermission`, so an API key's scope
 * applies). Answered with one permission check per distinct permission.
 */
export async function readableAuditTypes(
  request: FastifyRequest,
  types: readonly AuditEntityType[],
): Promise<AuditEntityType[]> {
  const needed = [...new Set(types.map((t) => AUDIT_READ_PERMISSION[t]).filter((p) => p != null))];
  const held = new Map<Permission, boolean>();
  await Promise.all(
    needed.map(async (permission) => {
      held.set(permission, await requestHasPermission(request, permission));
    }),
  );
  return types.filter((t) => {
    const permission = AUDIT_READ_PERMISSION[t];
    return permission == null || held.get(permission) === true;
  });
}
