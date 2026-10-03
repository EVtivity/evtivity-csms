// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: { get: mockGet, post: vi.fn(), patch: vi.fn() },
}));
vi.mock('../../i18n', () => ({ loadLanguage: vi.fn(() => Promise.resolve()) }));
vi.mock('../theme', () => ({ applyTheme: vi.fn(), resolveInitialTheme: () => 'light' }));

import { ApiError } from '../api';
import { useAuth } from '../auth';

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('useAuth.hydrate', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('keeps the chosen language and clears the role when the session is gone', async () => {
    localStorage.setItem('language', 'ko');
    localStorage.setItem('role', 'admin');
    mockGet.mockRejectedValueOnce(new ApiError(401, { code: 'UNAUTHORIZED' }));

    useAuth.getState().hydrate();
    await flush();

    expect(localStorage.getItem('language')).toBe('ko');
    expect(localStorage.getItem('role')).toBeNull();
    expect(useAuth.getState().isAuthenticated).toBe(false);
  });

  it('marks the API down on a server error without signing out', async () => {
    localStorage.setItem('role', 'admin');
    mockGet.mockRejectedValueOnce(new ApiError(503, null));

    useAuth.getState().hydrate();
    await flush();

    expect(useAuth.getState().apiDown).toBe(true);
    expect(localStorage.getItem('role')).toBe('admin');
  });
});
