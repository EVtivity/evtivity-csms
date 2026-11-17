// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';

const { refreshAccess } = vi.hoisted(() => ({ refreshAccess: vi.fn(() => Promise.resolve()) }));
vi.mock('../auth', () => ({ useAuth: { getState: () => ({ refreshAccess }) } }));

import { ApiError } from '../api';
import { queryClient } from '../query';

describe('queryClient and Fleets turned off', () => {
  it('reads the feature flags again after a 403 FLEET_DISABLED answer, and only then', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const fail = (code: string) => () =>
      Promise.reject(new ApiError(403, { error: 'refused', code }));
    await queryClient
      .fetchQuery({ queryKey: ['t', 'other'], queryFn: fail('FORBIDDEN'), retry: false })
      .catch(() => undefined);
    expect(invalidate).not.toHaveBeenCalled();
    await queryClient
      .fetchQuery({ queryKey: ['t', 'fleets'], queryFn: fail('FLEET_DISABLED'), retry: false })
      .catch(() => undefined);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['settings', 'features'] });
  });

  it('reads the user access again after a 403 FLEET_USER_NO_FLEETS answer', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await queryClient
      .fetchQuery({
        queryKey: ['t', 'no-fleets'],
        queryFn: () =>
          Promise.reject(new ApiError(403, { error: 'refused', code: 'FLEET_USER_NO_FLEETS' })),
        retry: false,
      })
      .catch(() => undefined);
    await vi.waitFor(() => {
      expect(refreshAccess).toHaveBeenCalled();
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
