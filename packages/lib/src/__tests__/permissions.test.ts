// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  hasPermission,
  isSubsetOf,
  hasAnySettingsPermission,
  createPermissionCatalog,
  permissionCatalog,
  PermissionCatalog,
} from '../permissions.js';

describe('hasPermission', () => {
  it('returns true when the exact permission is present', () => {
    expect(hasPermission(['stations:read', 'sites:read'], 'stations:read')).toBe(true);
  });

  it('returns false when the permission is not present', () => {
    expect(hasPermission(['stations:read'], 'sessions:read')).toBe(false);
  });

  it('returns false for empty permissions array', () => {
    expect(hasPermission([], 'stations:read')).toBe(false);
  });

  it('write implies read for the same resource', () => {
    expect(hasPermission(['stations:write'], 'stations:read')).toBe(true);
  });

  it('write implies read for settings resources', () => {
    expect(hasPermission(['settings.system:write'], 'settings.system:read')).toBe(true);
  });

  it('read does not imply write', () => {
    expect(hasPermission(['stations:read'], 'stations:write')).toBe(false);
  });

  it('write on one resource does not imply read on another', () => {
    expect(hasPermission(['stations:write'], 'sessions:read')).toBe(false);
  });

  it('handles non-read/write suffixes correctly', () => {
    expect(hasPermission(['custom:action'], 'custom:action')).toBe(true);
    expect(hasPermission(['custom:action'], 'custom:read')).toBe(false);
  });
});

describe('isSubsetOf', () => {
  it('returns true when subset is empty', () => {
    expect(isSubsetOf([], ['stations:read'])).toBe(true);
  });

  it('returns true when all subset permissions are in superset', () => {
    expect(
      isSubsetOf(['stations:read', 'sites:read'], ['stations:read', 'sites:read', 'sessions:read']),
    ).toBe(true);
  });

  it('returns false when a subset permission is missing', () => {
    expect(isSubsetOf(['stations:read', 'sessions:read'], ['stations:read'])).toBe(false);
  });

  it('accounts for write-implies-read when checking subset', () => {
    expect(isSubsetOf(['stations:read'], ['stations:write'])).toBe(true);
  });

  it('returns false when superset is empty and subset is not', () => {
    expect(isSubsetOf(['stations:read'], [])).toBe(false);
  });
});

describe('hasAnySettingsPermission', () => {
  it('returns true when user has a settings permission', () => {
    expect(hasAnySettingsPermission(['settings.system:read', 'stations:read'])).toBe(true);
  });

  it('returns false when user has no settings permissions', () => {
    expect(hasAnySettingsPermission(['stations:read', 'sessions:write'])).toBe(false);
  });

  it('returns false for empty permissions', () => {
    expect(hasAnySettingsPermission([])).toBe(false);
  });

  it('detects any settings prefix', () => {
    expect(hasAnySettingsPermission(['settings.apiKeys:write'])).toBe(true);
    expect(hasAnySettingsPermission(['settings.firmware:read'])).toBe(true);
  });
});

describe('built-in permission catalog', () => {
  const all = permissionCatalog.all();

  it('holds 33 resources with read and write each', () => {
    expect(permissionCatalog.groups()).toHaveLength(33);
    expect(all).toHaveLength(66);
    expect(new Set(all).size).toBe(all.length);
  });

  it('lists every permission in resource:action format without wildcards', () => {
    for (const p of all) {
      expect(p).toMatch(/^[\w.]+:(read|write)$/);
      expect(p).not.toContain('*');
    }
  });

  it('gives every group its read and write permission, kind and label key', () => {
    for (const g of permissionCatalog.groups()) {
      expect(g.permissions).toEqual([`${g.resource}:read`, `${g.resource}:write`]);
      expect(g.kind).toBe(g.resource.startsWith('settings.') ? 'settings' : 'page');
      expect(g.labelKey).toBe(`users.permissionGroups.${g.resource}`);
    }
  });

  it('lists all permissions in group order', () => {
    expect(all).toEqual(permissionCatalog.groups().flatMap((g) => [...g.permissions]));
  });

  it('knows its permissions and nothing else', () => {
    expect(permissionCatalog.isKnown('stations:read')).toBe(true);
    expect(permissionCatalog.isKnown('settings.payment:write')).toBe(true);
    expect(permissionCatalog.isKnown('stations:delete')).toBe(false);
    expect(permissionCatalog.isKnown('unknown:read')).toBe(false);
    expect(permissionCatalog.isKnown('')).toBe(false);
  });

  it('gives admin every permission', () => {
    expect(permissionCatalog.defaultsFor('admin')).toEqual(all);
  });

  it('gives operator operational access without settings or users:write', () => {
    const operator = permissionCatalog.defaultsFor('operator');
    expect(operator).toHaveLength(38);
    expect(operator).not.toContain('users:write');
    expect(operator.some((p) => p.startsWith('settings.'))).toBe(false);
    expect(operator).toContain('notifications:read');
    expect(operator).toContain('notifications:write');
    expect(operator).toContain('conformance:read');
    expect(operator).not.toContain('conformance:write');
    for (const p of operator) expect(permissionCatalog.isKnown(p)).toBe(true);
  });

  it('gives viewer read-only access to every page', () => {
    const viewer = permissionCatalog.defaultsFor('viewer');
    const pageReads = permissionCatalog
      .groups()
      .filter((g) => g.kind === 'page')
      .map((g) => g.permissions[0]);
    expect([...viewer].sort()).toEqual([...pageReads].sort());
  });

  it('gives any other role the operator defaults', () => {
    expect(permissionCatalog.defaultsFor('custom')).toEqual(
      permissionCatalog.defaultsFor('operator'),
    );
    expect(permissionCatalog.defaultsFor(undefined)).toEqual(
      permissionCatalog.defaultsFor('operator'),
    );
  });

  it('returns copies callers cannot use to change the catalog', () => {
    permissionCatalog.all().push('x:read');
    permissionCatalog.defaultsFor('operator').push('x:read');
    const [first] = permissionCatalog.groups();
    if (first != null) first.resource = 'changed';
    expect(permissionCatalog.all()).toHaveLength(66);
    expect(permissionCatalog.defaultsFor('operator')).toHaveLength(38);
    expect(permissionCatalog.groups()[0]?.resource).toBe('dashboard');
  });
});

describe('PermissionCatalog.register', () => {
  it('adds a resource with read and write, known and granted to admin', () => {
    const catalog = createPermissionCatalog();
    catalog.register({ resource: 'chargers', kind: 'page', labelKey: 'plugin.chargers' });
    expect(catalog.isKnown('chargers:read')).toBe(true);
    expect(catalog.isKnown('chargers:write')).toBe(true);
    expect(catalog.groups().at(-1)).toEqual({
      resource: 'chargers',
      kind: 'page',
      labelKey: 'plugin.chargers',
      permissions: ['chargers:read', 'chargers:write'],
    });
    expect(catalog.defaultsFor('admin')).toContain('chargers:write');
    expect(catalog.defaultsFor('operator')).not.toContain('chargers:read');
    expect(permissionCatalog.isKnown('chargers:read')).toBe(false);
  });

  it('adds a settings resource', () => {
    const catalog = new PermissionCatalog();
    catalog.register({ resource: 'settings.plugin', kind: 'settings', labelKey: 'plugin.tab' });
    expect(catalog.all()).toEqual(['settings.plugin:read', 'settings.plugin:write']);
  });

  it('refuses a duplicate resource', () => {
    const catalog = createPermissionCatalog();
    expect(() => {
      catalog.register({ resource: 'stations', kind: 'page', labelKey: 'x' });
    }).toThrow('already registered');
  });

  it('refuses a kind that does not match the settings prefix', () => {
    const catalog = new PermissionCatalog();
    expect(() => {
      catalog.register({ resource: 'settings.plugin', kind: 'page', labelKey: 'x' });
    }).toThrow('does not match kind');
    expect(() => {
      catalog.register({ resource: 'plugin', kind: 'settings', labelKey: 'x' });
    }).toThrow('does not match kind');
  });

  it('refuses a resource name that is not a plain identifier', () => {
    const catalog = new PermissionCatalog();
    for (const resource of ['', 'a:b', 'a*', 'Plugin', 'a.b', 'settings.', 'a b']) {
      expect(() => {
        catalog.register({ resource, kind: 'page', labelKey: 'x' });
      }).toThrow('Invalid permission resource');
    }
  });
});
