// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Permission catalog for the CSMS.
 * Format: `resource:action` where action is `read` or `write`.
 * Write implies read for the same resource.
 */

// Page-level permissions
export const PAGE_PERMISSIONS = [
  'dashboard:read',
  'dashboard:write',
  'stations:read',
  'stations:write',
  'sites:read',
  'sites:write',
  'sessions:read',
  'sessions:write',
  'drivers:read',
  'drivers:write',
  'fleets:read',
  'fleets:write',
  'reservations:read',
  'reservations:write',
  'support:read',
  'support:write',
  'payments:read',
  'payments:write',
  'pricing:read',
  'pricing:write',
  'roaming:read',
  'roaming:write',
  'smartCharging:read',
  'smartCharging:write',
  'certificates:read',
  'certificates:write',
  'conformance:read',
  'conformance:write',
  'reports:read',
  'reports:write',
  'sustainability:read',
  'sustainability:write',
  'loadManagement:read',
  'loadManagement:write',
  'notifications:read',
  'notifications:write',
  'logs:read',
  'logs:write',
  'users:read',
  'users:write',
] as const;

// Settings tab permissions
export const SETTINGS_PERMISSIONS = [
  'settings.system:read',
  'settings.system:write',
  'settings.notification:read',
  'settings.notification:write',
  'settings.payment:read',
  'settings.payment:write',
  'settings.integrations:read',
  'settings.integrations:write',
  'settings.security:read',
  'settings.security:write',
  'settings.apiKeys:read',
  'settings.apiKeys:write',
  'settings.firmware:read',
  'settings.firmware:write',
  'settings.stationConfig:read',
  'settings.stationConfig:write',
  'settings.smartCharging:read',
  'settings.smartCharging:write',
  'settings.ai:read',
  'settings.ai:write',
  'settings.conformance:read',
  'settings.conformance:write',
] as const;

/** All permissions in the system. */
export const PERMISSIONS = [...PAGE_PERMISSIONS, ...SETTINGS_PERMISSIONS] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Admin gets every permission. */
export const ADMIN_DEFAULT_PERMISSIONS: Permission[] = [...PERMISSIONS];

/** Operator gets operational read/write but no settings, no users:write. */
export const OPERATOR_DEFAULT_PERMISSIONS: Permission[] = [
  'dashboard:read',
  'dashboard:write',
  'stations:read',
  'stations:write',
  'sites:read',
  'sites:write',
  'sessions:read',
  'sessions:write',
  'drivers:read',
  'drivers:write',
  'fleets:read',
  'fleets:write',
  'reservations:read',
  'reservations:write',
  'support:read',
  'support:write',
  'payments:read',
  'payments:write',
  'pricing:read',
  'pricing:write',
  'roaming:read',
  'roaming:write',
  'smartCharging:read',
  'smartCharging:write',
  'certificates:read',
  'certificates:write',
  'conformance:read',
  'notifications:read',
  'notifications:write',
  'loadManagement:read',
  'loadManagement:write',
  'logs:read',
  'reports:read',
  'sustainability:read',
  'users:read',
];

/** Viewer gets read-only access to operational pages. No write, no settings. */
export const VIEWER_DEFAULT_PERMISSIONS: Permission[] = [
  'dashboard:read',
  'stations:read',
  'sites:read',
  'sessions:read',
  'drivers:read',
  'fleets:read',
  'reservations:read',
  'support:read',
  'payments:read',
  'pricing:read',
  'roaming:read',
  'smartCharging:read',
  'certificates:read',
  'conformance:read',
  'notifications:read',
  'loadManagement:read',
  'logs:read',
  'reports:read',
  'sustainability:read',
  'users:read',
];

/** Permission groups for the UI. */
export const PERMISSION_GROUPS = [
  {
    label: 'Dashboard',
    permissions: ['dashboard:read', 'dashboard:write'],
  },
  {
    label: 'Stations',
    permissions: ['stations:read', 'stations:write'],
  },
  {
    label: 'Sites',
    permissions: ['sites:read', 'sites:write'],
  },
  {
    label: 'Sessions',
    permissions: ['sessions:read', 'sessions:write'],
  },
  {
    label: 'Drivers',
    permissions: ['drivers:read', 'drivers:write'],
  },
  {
    label: 'Fleets',
    permissions: ['fleets:read', 'fleets:write'],
  },
  {
    label: 'Reservations',
    permissions: ['reservations:read', 'reservations:write'],
  },
  {
    label: 'Support Cases',
    permissions: ['support:read', 'support:write'],
  },
  {
    label: 'Payments',
    permissions: ['payments:read', 'payments:write'],
  },
  {
    label: 'Pricing',
    permissions: ['pricing:read', 'pricing:write'],
  },
  {
    label: 'Roaming',
    permissions: ['roaming:read', 'roaming:write'],
  },
  {
    label: 'Smart Charging',
    permissions: ['smartCharging:read', 'smartCharging:write'],
  },
  {
    label: 'Certificates',
    permissions: ['certificates:read', 'certificates:write'],
  },
  {
    label: 'Conformance',
    permissions: ['conformance:read', 'conformance:write'],
  },
  {
    label: 'Reports',
    permissions: ['reports:read', 'reports:write'],
  },
  {
    label: 'Sustainability',
    permissions: ['sustainability:read', 'sustainability:write'],
  },
  {
    label: 'Load Management',
    permissions: ['loadManagement:read', 'loadManagement:write'],
  },
  {
    label: 'Notifications',
    permissions: ['notifications:read', 'notifications:write'],
  },
  {
    label: 'Logs',
    permissions: ['logs:read', 'logs:write'],
  },
  {
    label: 'Users',
    permissions: ['users:read', 'users:write'],
  },
  {
    label: 'Settings - System',
    permissions: ['settings.system:read', 'settings.system:write'],
  },
  {
    label: 'Settings - Notification',
    permissions: ['settings.notification:read', 'settings.notification:write'],
  },
  {
    label: 'Settings - Payment',
    permissions: ['settings.payment:read', 'settings.payment:write'],
  },
  {
    label: 'Settings - Integrations',
    permissions: ['settings.integrations:read', 'settings.integrations:write'],
  },
  {
    label: 'Settings - Security',
    permissions: ['settings.security:read', 'settings.security:write'],
  },
  {
    label: 'Settings - API Keys',
    permissions: ['settings.apiKeys:read', 'settings.apiKeys:write'],
  },
  {
    label: 'Settings - Firmware',
    permissions: ['settings.firmware:read', 'settings.firmware:write'],
  },
  {
    label: 'Settings - Station Config',
    permissions: ['settings.stationConfig:read', 'settings.stationConfig:write'],
  },
  {
    label: 'Settings - Smart Charging',
    permissions: ['settings.smartCharging:read', 'settings.smartCharging:write'],
  },
  {
    label: 'Settings - AI',
    permissions: ['settings.ai:read', 'settings.ai:write'],
  },
  {
    label: 'Settings - Conformance',
    permissions: ['settings.conformance:read', 'settings.conformance:write'],
  },
] as const;

/**
 * Check if a user has a specific permission.
 * Write implies read for the same resource.
 */
export function hasPermission(userPermissions: string[], required: string): boolean {
  if (userPermissions.includes(required)) return true;

  // Write implies read: if user has `stations:write`, `stations:read` passes
  if (required.endsWith(':read')) {
    const writeVersion = required.replace(':read', ':write');
    if (userPermissions.includes(writeVersion)) return true;
  }

  return false;
}

/**
 * Check if a set of permissions is a valid subset of another.
 * Used to validate API key permissions against creator's permissions.
 */
export function isSubsetOf(subset: string[], superset: string[]): boolean {
  return subset.every((perm) => hasPermission(superset, perm));
}

/**
 * Check if user has any settings permission (used to show/hide Settings nav).
 */
export function hasAnySettingsPermission(userPermissions: string[]): boolean {
  return userPermissions.some((p) => p.startsWith('settings.'));
}
