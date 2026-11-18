// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  FLEET_MANAGER_ROLE_NAME,
  accessScopeForRole,
  isUserAccessScope,
} from '../user-access-scope.js';

describe('accessScopeForRole', () => {
  it('gives the Fleet Manager role fleets access and every other role sites access', () => {
    expect(accessScopeForRole(FLEET_MANAGER_ROLE_NAME)).toBe('fleets');
    for (const role of ['admin', 'operator', 'viewer', 'my_custom_role', '']) {
      expect(accessScopeForRole(role)).toBe('sites');
    }
  });

  it('knows only the two access scopes', () => {
    expect(isUserAccessScope('sites')).toBe(true);
    expect(isUserAccessScope('fleets')).toBe(true);
    expect(isUserAccessScope('all')).toBe(false);
  });
});
