// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const { mockGet, mockPost, mockPatch, mockLoadLanguage, mockApplyTheme } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPatch: vi.fn(),
  mockLoadLanguage: vi.fn(() => Promise.resolve()),
  mockApplyTheme: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: { get: mockGet, post: mockPost, patch: mockPatch },
}));
vi.mock('../../i18n', () => ({ loadLanguage: mockLoadLanguage }));
vi.mock('../theme', () => ({ applyTheme: mockApplyTheme, resolveInitialTheme: () => 'light' }));

import {
  useAuth,
  hasPermissionCheck,
  useHasPermission,
  useHasAnyPermission,
  MustResetPasswordError,
} from '../auth';

const user = {
  id: 'u1',
  email: 'a@b.c',
  firstName: 'Ada',
  lastName: 'Lovelace',
  language: 'de',
  timezone: 'Europe/Berlin',
  themePreference: 'dark' as const,
};

function resetStore(): void {
  useAuth.setState({
    user: null,
    role: null,
    permissions: [],
    theme: 'light',
    isAuthenticated: false,
    isHydrating: true,
    apiDown: false,
    mfaPending: null,
  });
}

describe('hasPermissionCheck', () => {
  it('grants an exact permission', () => {
    expect(hasPermissionCheck(['stations:read'], 'stations:read')).toBe(true);
  });

  it('lets write imply read for the same resource', () => {
    expect(hasPermissionCheck(['stations:write'], 'stations:read')).toBe(true);
  });

  it('does not let read imply write', () => {
    expect(hasPermissionCheck(['stations:read'], 'stations:write')).toBe(false);
  });

  it('does not let write on another resource imply read', () => {
    expect(hasPermissionCheck(['sites:write'], 'stations:read')).toBe(false);
  });
});

describe('permission hooks', () => {
  beforeEach(resetStore);

  it('useHasPermission reads the store permissions', () => {
    useAuth.setState({ permissions: ['drivers:write'] });
    expect(renderHook(() => useHasPermission('drivers:read')).result.current).toBe(true);
    expect(renderHook(() => useHasPermission('sites:read')).result.current).toBe(false);
  });

  it('useHasAnyPermission is true when one permission matches', () => {
    useAuth.setState({ permissions: ['sites:read'] });
    expect(renderHook(() => useHasAnyPermission(['x:read', 'sites:read'])).result.current).toBe(
      true,
    );
    expect(renderHook(() => useHasAnyPermission(['x:read', 'y:read'])).result.current).toBe(false);
    expect(renderHook(() => useHasAnyPermission([])).result.current).toBe(false);
  });
});

describe('useAuth', () => {
  beforeEach(() => {
    resetStore();
    localStorage.clear();
    sessionStorage.clear();
    mockGet.mockReset();
    mockPost.mockReset();
    mockPatch.mockReset();
    mockLoadLanguage.mockClear();
    mockApplyTheme.mockClear();
    mockPost.mockResolvedValue({});
    mockPatch.mockResolvedValue({});
  });

  describe('login', () => {
    it('stores preferences, loads permissions and logs the login', async () => {
      mockPost.mockResolvedValueOnce({ token: 't', user, role: { id: 'r1', name: 'admin' } });
      mockGet.mockResolvedValueOnce(['stations:read']);

      await useAuth.getState().login('a@b.c', 'pw', 'captcha');

      expect(mockPost).toHaveBeenCalledWith('/v1/auth/login', {
        email: 'a@b.c',
        password: 'pw',
        recaptchaToken: 'captcha',
      });
      expect(mockGet).toHaveBeenCalledWith('/v1/users/me/permissions');
      expect(localStorage.getItem('role')).toBe('admin');
      expect(localStorage.getItem('language')).toBe('de');
      expect(localStorage.getItem('timezone')).toBe('Europe/Berlin');
      expect(localStorage.getItem('theme')).toBe('dark');
      expect(mockApplyTheme).toHaveBeenCalledWith('dark');
      expect(mockLoadLanguage).toHaveBeenCalledWith('de');
      const s = useAuth.getState();
      expect(s.isAuthenticated).toBe(true);
      expect(s.user).toEqual(user);
      expect(s.role).toBe('admin');
      expect(s.permissions).toEqual(['stations:read']);
      expect(s.theme).toBe('dark');
      expect(mockPost).toHaveBeenCalledWith('/v1/access-logs', { action: 'login' });
    });

    it('omits the recaptcha token when not given and tolerates a null role', async () => {
      mockPost.mockResolvedValueOnce({ token: 't', user, role: null });
      mockGet.mockResolvedValueOnce([]);

      await useAuth.getState().login('a@b.c', 'pw');

      expect(mockPost).toHaveBeenCalledWith('/v1/auth/login', { email: 'a@b.c', password: 'pw' });
      expect(localStorage.getItem('role')).toBe('');
      expect(useAuth.getState().role).toBeNull();
    });

    it('signs in with no permissions when the permissions call fails', async () => {
      mockPost.mockResolvedValueOnce({ token: 't', user, role: null });
      mockGet.mockRejectedValueOnce(new Error('boom'));

      await useAuth.getState().login('a@b.c', 'pw');

      expect(useAuth.getState().isAuthenticated).toBe(true);
      expect(useAuth.getState().permissions).toEqual([]);
    });

    it('still signs in when the access log call fails', async () => {
      mockPost
        .mockResolvedValueOnce({ token: 't', user, role: null })
        .mockRejectedValueOnce(new Error('log down'));
      mockGet.mockResolvedValueOnce([]);

      await expect(useAuth.getState().login('a@b.c', 'pw')).resolves.toBeUndefined();
      expect(useAuth.getState().isAuthenticated).toBe(true);
    });

    it('throws MustResetPasswordError and stays signed out', async () => {
      mockPost.mockResolvedValueOnce({ mustResetPassword: true });

      const err = await useAuth
        .getState()
        .login('a@b.c', 'pw')
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(MustResetPasswordError);
      expect((err as Error).message).toBe('must_reset_password');
      expect((err as Error).name).toBe('MustResetPasswordError');
      expect(useAuth.getState().isAuthenticated).toBe(false);
    });

    it('records a pending MFA challenge with its challenge id', async () => {
      mockPost.mockResolvedValueOnce({
        mfaRequired: true,
        mfaMethod: 'email',
        mfaToken: 'mt',
        challengeId: 'c1',
      });

      await useAuth.getState().login('a@b.c', 'pw');

      expect(useAuth.getState().mfaPending).toEqual({
        mfaRequired: true,
        mfaMethod: 'email',
        mfaToken: 'mt',
        challengeId: 'c1',
      });
      expect(useAuth.getState().isAuthenticated).toBe(false);
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('records a pending MFA challenge without a challenge id', async () => {
      mockPost.mockResolvedValueOnce({ mfaRequired: true, mfaMethod: 'totp', mfaToken: 'mt' });

      await useAuth.getState().login('a@b.c', 'pw');

      expect(useAuth.getState().mfaPending).toEqual({
        mfaRequired: true,
        mfaMethod: 'totp',
        mfaToken: 'mt',
      });
    });
  });

  describe('MFA state', () => {
    it('completeMfaLogin signs in and clears the pending challenge', async () => {
      useAuth.getState().setMfaPending({ mfaRequired: true, mfaMethod: 'totp', mfaToken: 'mt' });
      mockGet.mockResolvedValueOnce(['users:read']);

      await useAuth.getState().completeMfaLogin(user, 'operator');

      const s = useAuth.getState();
      expect(s.mfaPending).toBeNull();
      expect(s.isAuthenticated).toBe(true);
      expect(s.role).toBe('operator');
      expect(s.permissions).toEqual(['users:read']);
      expect(localStorage.getItem('role')).toBe('operator');
      expect(localStorage.getItem('theme')).toBe('dark');
      expect(mockLoadLanguage).toHaveBeenCalledWith('de');
      expect(mockPost).toHaveBeenCalledWith('/v1/access-logs', { action: 'login' });
    });

    it('completeMfaLogin stores an empty role and empty permissions on failure', async () => {
      mockGet.mockRejectedValueOnce(new Error('x'));

      await useAuth.getState().completeMfaLogin(user, null);

      expect(localStorage.getItem('role')).toBe('');
      expect(useAuth.getState().permissions).toEqual([]);
    });

    it('clearMfaPending removes the challenge', () => {
      useAuth.getState().setMfaPending({ mfaRequired: true, mfaMethod: 'sms', mfaToken: 'm' });
      expect(useAuth.getState().mfaPending?.mfaMethod).toBe('sms');
      useAuth.getState().clearMfaPending();
      expect(useAuth.getState().mfaPending).toBeNull();
    });
  });

  describe('logout', () => {
    it('revokes on the server, then clears local state', async () => {
      useAuth.setState({ user, role: 'admin', permissions: ['a:read'], isAuthenticated: true });
      localStorage.setItem('role', 'admin');

      await useAuth.getState().logout();

      expect(mockPost).toHaveBeenCalledWith('/v1/access-logs', { action: 'logout' });
      expect(mockPost).toHaveBeenCalledWith('/v1/auth/logout', {});
      expect(localStorage.getItem('role')).toBeNull();
      expect(sessionStorage.getItem('noAutoLogin')).toBe('true');
      const s = useAuth.getState();
      expect(s.user).toBeNull();
      expect(s.role).toBeNull();
      expect(s.permissions).toEqual([]);
      expect(s.isAuthenticated).toBe(false);
    });

    it('clears local state even when the server call fails', async () => {
      useAuth.setState({ user, isAuthenticated: true });
      mockPost.mockRejectedValue(new Error('offline'));

      await useAuth.getState().logout();

      expect(useAuth.getState().isAuthenticated).toBe(false);
      expect(useAuth.getState().user).toBeNull();
    });
  });

  describe('hydrate', () => {
    it('signs in from /v1/users/me', async () => {
      mockGet.mockResolvedValueOnce({
        ...user,
        roleId: 'r1',
        role: { id: 'r1', name: 'admin' },
        permissions: ['sites:write'],
      });

      useAuth.getState().hydrate();
      expect(useAuth.getState().isHydrating).toBe(true);
      await vi.waitFor(() => {
        expect(useAuth.getState().isHydrating).toBe(false);
      });

      const s = useAuth.getState();
      expect(mockGet).toHaveBeenCalledWith('/v1/users/me');
      expect(s.isAuthenticated).toBe(true);
      expect(s.user).toEqual(user);
      expect(s.role).toBe('admin');
      expect(s.permissions).toEqual(['sites:write']);
      expect(s.theme).toBe('dark');
      expect(localStorage.getItem('role')).toBe('admin');
      expect(localStorage.getItem('timezone')).toBe('Europe/Berlin');
      expect(mockApplyTheme).toHaveBeenCalledWith('dark');
    });

    it('stores an empty role when the user has none', async () => {
      mockGet.mockResolvedValueOnce({ ...user, roleId: '', role: null, permissions: [] });

      useAuth.getState().hydrate();
      await vi.waitFor(() => {
        expect(useAuth.getState().isHydrating).toBe(false);
      });

      expect(localStorage.getItem('role')).toBe('');
      expect(useAuth.getState().role).toBeNull();
    });

    it('marks the API down on a network TypeError', async () => {
      mockGet.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      useAuth.getState().hydrate();
      await vi.waitFor(() => {
        expect(useAuth.getState().isHydrating).toBe(false);
      });

      expect(useAuth.getState().apiDown).toBe(true);
    });

    it('retryConnection clears apiDown and hydrates again', async () => {
      useAuth.setState({ apiDown: true, isHydrating: false });
      mockGet.mockResolvedValueOnce({ ...user, roleId: 'r', role: null, permissions: [] });

      useAuth.getState().retryConnection();
      expect(useAuth.getState().apiDown).toBe(false);
      expect(useAuth.getState().isHydrating).toBe(true);
      await vi.waitFor(() => {
        expect(useAuth.getState().isAuthenticated).toBe(true);
      });
    });
  });

  describe('preferences', () => {
    it('setLanguage stores, loads and persists for a signed-in user', async () => {
      useAuth.setState({ user });
      await useAuth.getState().setLanguage('ko');
      expect(localStorage.getItem('language')).toBe('ko');
      expect(mockLoadLanguage).toHaveBeenCalledWith('ko');
      expect(useAuth.getState().user?.language).toBe('ko');
      expect(mockPatch).toHaveBeenCalledWith('/v1/users/me', { language: 'ko' });
    });

    it('setLanguage does not call the API when signed out', async () => {
      await useAuth.getState().setLanguage('es');
      expect(localStorage.getItem('language')).toBe('es');
      expect(mockLoadLanguage).toHaveBeenCalledWith('es');
      expect(mockPatch).not.toHaveBeenCalled();
    });

    it('setTimezone stores and persists for a signed-in user', async () => {
      useAuth.setState({ user });
      await useAuth.getState().setTimezone('Asia/Seoul');
      expect(localStorage.getItem('timezone')).toBe('Asia/Seoul');
      expect(useAuth.getState().user?.timezone).toBe('Asia/Seoul');
      expect(mockPatch).toHaveBeenCalledWith('/v1/users/me', { timezone: 'Asia/Seoul' });
    });

    it('setTimezone does not call the API when signed out', async () => {
      await useAuth.getState().setTimezone('UTC');
      expect(localStorage.getItem('timezone')).toBe('UTC');
      expect(mockPatch).not.toHaveBeenCalled();
    });

    it('setTheme applies, stores and persists for a signed-in user', async () => {
      useAuth.setState({ user });
      await useAuth.getState().setTheme('light');
      expect(localStorage.getItem('theme')).toBe('light');
      expect(mockApplyTheme).toHaveBeenCalledWith('light');
      expect(useAuth.getState().theme).toBe('light');
      expect(useAuth.getState().user?.themePreference).toBe('light');
      expect(mockPatch).toHaveBeenCalledWith('/v1/users/me', { themePreference: 'light' });
    });

    it('setTheme applies locally when signed out', async () => {
      await useAuth.getState().setTheme('dark');
      expect(useAuth.getState().theme).toBe('dark');
      expect(mockPatch).not.toHaveBeenCalled();
    });

    it('applyLanguageLocal updates without an API call', async () => {
      useAuth.setState({ user });
      await useAuth.getState().applyLanguageLocal('zh');
      expect(localStorage.getItem('language')).toBe('zh');
      expect(mockLoadLanguage).toHaveBeenCalledWith('zh');
      expect(useAuth.getState().user?.language).toBe('zh');
      expect(mockPatch).not.toHaveBeenCalled();
    });

    it('applyLanguageLocal leaves a signed-out store without a user', async () => {
      await useAuth.getState().applyLanguageLocal('zh');
      expect(useAuth.getState().user).toBeNull();
    });

    it('applyTimezoneLocal updates without an API call', () => {
      useAuth.setState({ user });
      useAuth.getState().applyTimezoneLocal('America/Denver');
      expect(localStorage.getItem('timezone')).toBe('America/Denver');
      expect(useAuth.getState().user?.timezone).toBe('America/Denver');
      expect(mockPatch).not.toHaveBeenCalled();
    });

    it('applyTimezoneLocal only stores when signed out', () => {
      useAuth.getState().applyTimezoneLocal('UTC');
      expect(localStorage.getItem('timezone')).toBe('UTC');
      expect(useAuth.getState().user).toBeNull();
    });
  });
});
