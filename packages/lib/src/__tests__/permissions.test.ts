// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  hasPermission,
  isSubsetOf,
  hasAnySettingsPermission,
  PERMISSIONS,
  PAGE_PERMISSIONS,
  SETTINGS_PERMISSIONS,
  ADMIN_DEFAULT_PERMISSIONS,
  OPERATOR_DEFAULT_PERMISSIONS,
  PERMISSION_GROUPS,
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

describe('permission catalog constants', () => {
  it('PERMISSIONS includes all page and settings permissions', () => {
    expect(PERMISSIONS.length).toBe(PAGE_PERMISSIONS.length + SETTINGS_PERMISSIONS.length);
    for (const p of PAGE_PERMISSIONS) {
      expect(PERMISSIONS).toContain(p);
    }
    for (const p of SETTINGS_PERMISSIONS) {
      expect(PERMISSIONS).toContain(p);
    }
  });

  it('all permissions follow resource:action format', () => {
    for (const p of PERMISSIONS) {
      expect(p).toMatch(/^[\w.]+:(read|write)$/);
    }
  });

  it('every resource has both read and write', () => {
    const resources = new Set(PERMISSIONS.map((p) => p.replace(/:(read|write)$/, '')));
    for (const r of resources) {
      expect(PERMISSIONS).toContain(`${r}:read`);
      expect(PERMISSIONS).toContain(`${r}:write`);
    }
  });

  it('ADMIN_DEFAULT_PERMISSIONS includes all permissions', () => {
    expect(ADMIN_DEFAULT_PERMISSIONS.length).toBe(PERMISSIONS.length);
    for (const p of PERMISSIONS) {
      expect(ADMIN_DEFAULT_PERMISSIONS).toContain(p);
    }
  });

  it('OPERATOR_DEFAULT_PERMISSIONS is a subset of all permissions', () => {
    for (const p of OPERATOR_DEFAULT_PERMISSIONS) {
      expect(PERMISSIONS).toContain(p);
    }
  });

  it('OPERATOR_DEFAULT_PERMISSIONS does not include users:write', () => {
    expect(OPERATOR_DEFAULT_PERMISSIONS).not.toContain('users:write');
  });

  it('OPERATOR_DEFAULT_PERMISSIONS does not include any settings permissions', () => {
    for (const p of OPERATOR_DEFAULT_PERMISSIONS) {
      expect(p.startsWith('settings.')).toBe(false);
    }
  });

  it('OPERATOR_DEFAULT_PERMISSIONS includes notifications read and write', () => {
    expect(OPERATOR_DEFAULT_PERMISSIONS).toContain('notifications:read');
    expect(OPERATOR_DEFAULT_PERMISSIONS).toContain('notifications:write');
  });

  it('no wildcards exist in any permission constant', () => {
    for (const p of PERMISSIONS) {
      expect(p).not.toContain('*');
    }
    for (const p of ADMIN_DEFAULT_PERMISSIONS) {
      expect(p).not.toContain('*');
    }
    for (const p of OPERATOR_DEFAULT_PERMISSIONS) {
      expect(p).not.toContain('*');
    }
  });

  it('PERMISSION_GROUPS covers all permissions', () => {
    const grouped = PERMISSION_GROUPS.flatMap((g) => g.permissions);
    for (const p of PERMISSIONS) {
      expect(grouped).toContain(p);
    }
  });
});
