// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Permission catalog for the CSMS.
 * Format: `resource:action` where action is `read` or `write`.
 * Write implies read for the same resource.
 */

export type PermissionAction = 'read' | 'write';

/** A page permission guards a CSMS page, a settings permission a Settings tab. */
export type PermissionKind = 'page' | 'settings';

/** One resource of the catalog with its read and write permissions. */
export interface PermissionGroup {
  /** The resource part of the permissions, e.g. `stations` or `settings.payment`. */
  resource: string;
  kind: PermissionKind;
  /** CSMS locale key of the group label. */
  labelKey: string;
  /** `<resource>:read` and `<resource>:write`. */
  permissions: readonly [string, string];
}

/** What a caller registers: the permissions follow from the resource. */
export interface PermissionGroupDefinition {
  resource: string;
  kind: PermissionKind;
  labelKey: string;
}

const BUILT_IN_GROUPS = [
  { resource: 'dashboard', kind: 'page' },
  { resource: 'stations', kind: 'page' },
  { resource: 'sites', kind: 'page' },
  { resource: 'sessions', kind: 'page' },
  { resource: 'drivers', kind: 'page' },
  { resource: 'fleets', kind: 'page' },
  { resource: 'reservations', kind: 'page' },
  { resource: 'support', kind: 'page' },
  { resource: 'payments', kind: 'page' },
  { resource: 'pricing', kind: 'page' },
  { resource: 'roaming', kind: 'page' },
  { resource: 'smartCharging', kind: 'page' },
  { resource: 'certificates', kind: 'page' },
  { resource: 'conformance', kind: 'page' },
  { resource: 'reports', kind: 'page' },
  { resource: 'sustainability', kind: 'page' },
  { resource: 'loadManagement', kind: 'page' },
  { resource: 'notifications', kind: 'page' },
  { resource: 'logs', kind: 'page' },
  { resource: 'users', kind: 'page' },
  { resource: 'audit', kind: 'page' },
  { resource: 'maintenance', kind: 'page' },
  { resource: 'settings.system', kind: 'settings' },
  { resource: 'settings.notification', kind: 'settings' },
  { resource: 'settings.payment', kind: 'settings' },
  { resource: 'settings.integrations', kind: 'settings' },
  { resource: 'settings.security', kind: 'settings' },
  { resource: 'settings.apiKeys', kind: 'settings' },
  { resource: 'settings.firmware', kind: 'settings' },
  { resource: 'settings.stationConfig', kind: 'settings' },
  { resource: 'settings.smartCharging', kind: 'settings' },
  { resource: 'settings.ai', kind: 'settings' },
  { resource: 'settings.conformance', kind: 'settings' },
] as const satisfies readonly { resource: string; kind: PermissionKind }[];

type BuiltInResource = (typeof BUILT_IN_GROUPS)[number]['resource'];

/** A built-in permission. Registered permissions are plain strings. */
export type Permission = `${BuiltInResource}:${PermissionAction}`;

/** Operator gets operational read/write but no settings, no users:write. */
const OPERATOR_DEFAULTS: readonly Permission[] = [
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
  'audit:read',
  'maintenance:read',
  'maintenance:write',
];

/** Viewer gets read-only access to operational pages. No write, no settings. */
const VIEWER_DEFAULTS: readonly Permission[] = [
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
  'audit:read',
  'maintenance:read',
];

const RESOURCE_PATTERN = /^(settings\.)?[a-z][a-zA-Z0-9]*$/;

/** The permissions a role may be granted, grouped by resource for the permission editor. */
export class PermissionCatalog {
  private readonly groupList: PermissionGroup[] = [];
  private readonly known = new Set<string>();

  /** Adds a resource with its read and write permissions. Throws on a duplicate or bad name. */
  register(definition: PermissionGroupDefinition): void {
    const { resource, kind, labelKey } = definition;
    if (!RESOURCE_PATTERN.test(resource)) {
      throw new Error(`Invalid permission resource "${resource}"`);
    }
    // Settings permissions keep the `settings.` prefix: hasAnySettingsPermission relies on it.
    if (resource.startsWith('settings.') !== (kind === 'settings')) {
      throw new Error(`Permission resource "${resource}" does not match kind "${kind}"`);
    }
    if (this.groupList.some((g) => g.resource === resource)) {
      throw new Error(`Permission resource "${resource}" is already registered`);
    }
    const permissions = [`${resource}:read`, `${resource}:write`] as const;
    this.groupList.push({ resource, kind, labelKey, permissions });
    for (const p of permissions) this.known.add(p);
  }

  /** True when the permission is in the catalog. */
  isKnown(permission: string): boolean {
    return this.known.has(permission);
  }

  /** Every permission, in group order. */
  all(): string[] {
    return this.groupList.flatMap((g) => [...g.permissions]);
  }

  /** The groups in registration order. */
  groups(): PermissionGroup[] {
    return this.groupList.map((g) => ({ ...g }));
  }

  /**
   * The permissions a new user of the role starts with. Admin gets every permission, viewer
   * the read-only set, and operator (and any other role) the operational set.
   */
  defaultsFor(role: string | undefined): string[] {
    if (role === 'admin') return this.all();
    return [...(role === 'viewer' ? VIEWER_DEFAULTS : OPERATOR_DEFAULTS)];
  }
}

/** A catalog holding the built-in permissions. */
export function createPermissionCatalog(): PermissionCatalog {
  const catalog = new PermissionCatalog();
  for (const { resource, kind } of BUILT_IN_GROUPS) {
    catalog.register({ resource, kind, labelKey: `users.permissionGroups.${resource}` });
  }
  return catalog;
}

/** The process-wide permission catalog. */
export const permissionCatalog = createPermissionCatalog();

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
