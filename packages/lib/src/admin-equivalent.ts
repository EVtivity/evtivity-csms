// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { permissionCatalog } from './permissions.js';

/**
 * Permissions that reach every other one: managing users and their
 * permissions, sign-in security, API keys, system settings and payment
 * settings.
 */
export const ADMIN_EQUIVALENT_PERMISSIONS: readonly string[] = [
  'users:write',
  'settings.security:write',
  'settings.apiKeys:write',
  'settings.system:write',
  'settings.payment:write',
];

/**
 * Whether a permission set is admin-equivalent: it holds
 * every catalog permission, or any permission that reaches the others. Creating
 * such a user, changing its email or granting such a set takes a fresh proof
 * from a session.
 */
export function isAdminEquivalent(permissions: readonly string[]): boolean {
  const held = new Set(permissions);
  if (ADMIN_EQUIVALENT_PERMISSIONS.some((p) => held.has(p))) return true;
  const all = permissionCatalog.all();
  return all.length > 0 && all.every((p) => held.has(p));
}
