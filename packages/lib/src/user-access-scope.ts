// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * What a CSMS user reaches: `sites` (all sites or its assigned sites) or `fleets` (only the
 * fleets assigned to it). Browser-safe: no server imports.
 */
export const USER_ACCESS_SCOPES = ['sites', 'fleets'] as const;

export type UserAccessScope = (typeof USER_ACCESS_SCOPES)[number];

/** The built-in role whose users start with the fleet user permissions and the fleets scope. */
export const FLEET_MANAGER_ROLE_NAME = 'fleet_manager';

/**
 * The only access scope a role takes: fleets for the Fleet Manager role, sites
 * (all sites or some sites) for every other role, custom roles included.
 */
export function accessScopeForRole(roleName: string): UserAccessScope {
  return roleName === FLEET_MANAGER_ROLE_NAME ? 'fleets' : 'sites';
}

/** True for a known access scope. */
export function isUserAccessScope(value: unknown): value is UserAccessScope {
  return typeof value === 'string' && (USER_ACCESS_SCOPES as readonly string[]).includes(value);
}
