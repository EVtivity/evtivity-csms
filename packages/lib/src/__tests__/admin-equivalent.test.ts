// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { ADMIN_EQUIVALENT_PERMISSIONS, isAdminEquivalent } from '../admin-equivalent.js';
import { permissionCatalog } from '../permissions.js';

describe('isAdminEquivalent', () => {
  it('holds for every catalog permission', () => {
    expect(isAdminEquivalent(permissionCatalog.all())).toBe(true);
  });

  it.each(ADMIN_EQUIVALENT_PERMISSIONS)('holds for %s alone', (permission) => {
    expect(isAdminEquivalent([permission])).toBe(true);
  });

  it('does not hold for a set without them', () => {
    expect(isAdminEquivalent(['stations:read', 'payments:write', 'users:read'])).toBe(false);
    expect(isAdminEquivalent([])).toBe(false);
  });

  it('names only catalog permissions', () => {
    for (const permission of ADMIN_EQUIVALENT_PERMISSIONS) {
      expect(permissionCatalog.isKnown(permission)).toBe(true);
    }
  });
});
