// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('../../i18n/index', () => ({ loadLanguage: mockLoadLanguage }));
vi.mock('../theme', () => ({ applyTheme: mockApplyTheme }));

import { ApiError } from '../api';
import { useAuth } from '../auth';
import { queryClient } from '../query';

const driver = {
  id: 'd1',
  firstName: 'Grace',
  lastName: 'Hopper',
  email: 'g@h.io',
  phone: null,
  language: 'es',
  timezone: 'America/Mexico_City',
  themePreference: 'dark' as const,
  distanceUnit: 'km' as const,
  priceDisplay: null,
  isActive: true,
  emailVerified: true,
};

const PORTAL_KEYS = [
  'portal_language',
  'portal_timezone',
  'portal_theme',
  'portal_distance_unit',
] as const;

function expectStoredPreferences(): void {
  expect(localStorage.getItem('portal_language')).toBe('es');
  expect(localStorage.getItem('portal_timezone')).toBe('America/Mexico_City');
  expect(localStorage.getItem('portal_theme')).toBe('dark');
  expect(mockApplyTheme).toHaveBeenCalledWith('dark');
  expect(mockLoadLanguage).toHaveBeenCalledWith('es');
}

describe('portal useAuth', () => {
  beforeEach(() => {
    useAuth.setState({
      driver: null,
      isAuthenticated: false,
      isHydrating: true,
      apiDown: false,
      theme: 'light',
      mfaPending: null,
    });
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
    it('signs the driver in and stores preferences', async () => {
      mockPost.mockResolvedValueOnce({ driver });

      await useAuth.getState().login('g@h.io', 'pw', 'cap');

      expect(mockPost).toHaveBeenCalledWith('/v1/portal/auth/login', {
        email: 'g@h.io',
        password: 'pw',
        recaptchaToken: 'cap',
      });
      expectStoredPreferences();
      expect(localStorage.getItem('portal_distance_unit')).toBe('km');
      const s = useAuth.getState();
      expect(s.driver).toEqual(driver);
      expect(s.isAuthenticated).toBe(true);
      expect(s.theme).toBe('dark');
      expect(mockPost).toHaveBeenCalledWith('/v1/portal/access-logs', { action: 'login' });
    });

    it('sends no recaptcha token when none is given', async () => {
      mockPost.mockResolvedValueOnce({ driver });
      await useAuth.getState().login('g@h.io', 'pw');
      expect(mockPost).toHaveBeenCalledWith('/v1/portal/auth/login', {
        email: 'g@h.io',
        password: 'pw',
      });
    });

    it('still signs in when the access log call fails', async () => {
      mockPost.mockResolvedValueOnce({ driver }).mockRejectedValueOnce(new Error('down'));
      await expect(useAuth.getState().login('g@h.io', 'pw')).resolves.toBeUndefined();
      expect(useAuth.getState().isAuthenticated).toBe(true);
    });

    it('records an MFA challenge with a challenge id and stays signed out', async () => {
      mockPost.mockResolvedValueOnce({
        mfaRequired: true,
        mfaMethod: 'sms',
        mfaToken: 'mt',
        challengeId: 'ch',
      });

      await useAuth.getState().login('g@h.io', 'pw');

      expect(useAuth.getState().mfaPending).toEqual({
        mfaRequired: true,
        mfaMethod: 'sms',
        mfaToken: 'mt',
        challengeId: 'ch',
      });
      expect(useAuth.getState().isAuthenticated).toBe(false);
      expect(localStorage.getItem('portal_language')).toBeNull();
    });

    it('records an MFA challenge without a challenge id', async () => {
      mockPost.mockResolvedValueOnce({ mfaRequired: true, mfaMethod: 'totp', mfaToken: 'mt' });
      await useAuth.getState().login('g@h.io', 'pw');
      expect(useAuth.getState().mfaPending).toEqual({
        mfaRequired: true,
        mfaMethod: 'totp',
        mfaToken: 'mt',
      });
    });
  });

  it('register signs the new driver in', async () => {
    mockPost.mockResolvedValueOnce({ driver });
    const body = { firstName: 'Grace', lastName: 'Hopper', email: 'g@h.io', password: 'pw' };

    await useAuth.getState().register(body);

    expect(mockPost).toHaveBeenCalledWith('/v1/portal/auth/register', body);
    expectStoredPreferences();
    expect(useAuth.getState().isAuthenticated).toBe(true);
    expect(useAuth.getState().driver?.id).toBe('d1');
  });

  it('register propagates an API failure without signing in', async () => {
    mockPost.mockRejectedValueOnce(new ApiError(409, { code: 'EMAIL_TAKEN' }));
    await expect(
      useAuth.getState().register({ firstName: 'a', lastName: 'b', email: 'c', password: 'd' }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(useAuth.getState().isAuthenticated).toBe(false);
  });

  it('completeMfaLogin signs in and clears the challenge', async () => {
    useAuth.setState({ mfaPending: { mfaRequired: true, mfaMethod: 'sms', mfaToken: 'm' } });

    await useAuth.getState().completeMfaLogin(driver);

    expectStoredPreferences();
    expect(useAuth.getState().mfaPending).toBeNull();
    expect(useAuth.getState().isAuthenticated).toBe(true);
    expect(mockPost).toHaveBeenCalledWith('/v1/portal/access-logs', { action: 'login' });
  });

  it('clearMfaPending removes the challenge', () => {
    useAuth.setState({ mfaPending: { mfaRequired: true, mfaMethod: 'sms', mfaToken: 'm' } });
    useAuth.getState().clearMfaPending();
    expect(useAuth.getState().mfaPending).toBeNull();
  });

  describe('logout', () => {
    it('revokes on the server and clears every portal key', async () => {
      useAuth.setState({ driver, isAuthenticated: true });
      for (const k of PORTAL_KEYS) localStorage.setItem(k, 'x');
      localStorage.setItem('evtivity-driver-location', '{}');
      localStorage.setItem('unrelated', 'keep');

      await useAuth.getState().logout();

      expect(mockPost).toHaveBeenCalledWith('/v1/portal/access-logs', { action: 'logout' });
      expect(mockPost).toHaveBeenCalledWith('/v1/portal/auth/logout', {});
      for (const k of PORTAL_KEYS) expect(localStorage.getItem(k)).toBeNull();
      expect(localStorage.getItem('evtivity-driver-location')).toBeNull();
      expect(localStorage.getItem('unrelated')).toBe('keep');
      expect(sessionStorage.getItem('noAutoLogin')).toBe('true');
      expect(useAuth.getState().driver).toBeNull();
      expect(useAuth.getState().isAuthenticated).toBe(false);
    });

    it('drops the cached driver queries, the billing state included', async () => {
      useAuth.setState({ driver, isAuthenticated: true });
      queryClient.setQueryData(['portal-driver-billing'], {
        billing: { mode: 'account', fleetName: 'Acme' },
      });
      queryClient.setQueryData(['portal-sessions'], []);

      await useAuth.getState().logout();

      expect(queryClient.getQueryData(['portal-driver-billing'])).toBeUndefined();
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    });

    it('clears local state even when the server call fails', async () => {
      useAuth.setState({ driver, isAuthenticated: true });
      mockPost.mockRejectedValue(new Error('offline'));

      await useAuth.getState().logout();

      expect(useAuth.getState().isAuthenticated).toBe(false);
    });
  });

  describe('hydrate', () => {
    it('signs in from /v1/portal/auth/me', async () => {
      mockGet.mockResolvedValueOnce(driver);

      useAuth.getState().hydrate();
      await vi.waitFor(() => {
        expect(useAuth.getState().isHydrating).toBe(false);
      });

      expect(mockGet).toHaveBeenCalledWith('/v1/portal/auth/me');
      expectStoredPreferences();
      expect(useAuth.getState().isAuthenticated).toBe(true);
      expect(useAuth.getState().theme).toBe('dark');
    });

    it('signs out on an auth error', async () => {
      useAuth.setState({ driver, isAuthenticated: true });
      mockGet.mockRejectedValueOnce(new ApiError(401, { code: 'UNAUTHORIZED' }));

      useAuth.getState().hydrate();
      await vi.waitFor(() => {
        expect(useAuth.getState().isHydrating).toBe(false);
      });

      expect(useAuth.getState().isAuthenticated).toBe(false);
      expect(useAuth.getState().driver).toBeNull();
      expect(useAuth.getState().apiDown).toBe(false);
    });

    it.each([
      ['a network TypeError', new TypeError('Failed to fetch')],
      ['a 502 gateway error', new ApiError(502, null)],
    ])('marks the API down on %s without signing out', async (_label, err) => {
      useAuth.setState({ driver, isAuthenticated: true });
      mockGet.mockRejectedValueOnce(err);

      useAuth.getState().hydrate();
      await vi.waitFor(() => {
        expect(useAuth.getState().isHydrating).toBe(false);
      });

      expect(useAuth.getState().apiDown).toBe(true);
      expect(useAuth.getState().isAuthenticated).toBe(true);
    });

    it('retryConnection clears apiDown and hydrates again', async () => {
      useAuth.setState({ apiDown: true, isHydrating: false });
      mockGet.mockResolvedValueOnce(driver);

      useAuth.getState().retryConnection();
      expect(useAuth.getState().apiDown).toBe(false);
      expect(useAuth.getState().isHydrating).toBe(true);
      await vi.waitFor(() => {
        expect(useAuth.getState().isAuthenticated).toBe(true);
      });
    });
  });

  describe('preferences with a signed-in driver', () => {
    beforeEach(() => {
      useAuth.setState({ driver, isAuthenticated: true });
    });

    it('setLanguage persists to the profile', async () => {
      await useAuth.getState().setLanguage('ko');
      expect(localStorage.getItem('portal_language')).toBe('ko');
      expect(mockLoadLanguage).toHaveBeenCalledWith('ko');
      expect(useAuth.getState().driver?.language).toBe('ko');
      expect(mockPatch).toHaveBeenCalledWith('/v1/portal/driver/profile', { language: 'ko' });
    });

    it('setTimezone persists to the profile', async () => {
      await useAuth.getState().setTimezone('UTC');
      expect(localStorage.getItem('portal_timezone')).toBe('UTC');
      expect(useAuth.getState().driver?.timezone).toBe('UTC');
      expect(mockPatch).toHaveBeenCalledWith('/v1/portal/driver/profile', { timezone: 'UTC' });
    });

    it('setTheme applies and persists to the profile', async () => {
      await useAuth.getState().setTheme('light');
      expect(mockApplyTheme).toHaveBeenCalledWith('light');
      expect(useAuth.getState().theme).toBe('light');
      expect(useAuth.getState().driver?.themePreference).toBe('light');
      expect(mockPatch).toHaveBeenCalledWith('/v1/portal/driver/profile', {
        themePreference: 'light',
      });
    });

    it('setDistanceUnit persists to the profile', async () => {
      await useAuth.getState().setDistanceUnit('miles');
      expect(localStorage.getItem('portal_distance_unit')).toBe('miles');
      expect(useAuth.getState().driver?.distanceUnit).toBe('miles');
      expect(mockPatch).toHaveBeenCalledWith('/v1/portal/driver/profile', {
        distanceUnit: 'miles',
      });
    });

    it('local appliers update the driver without an API call', async () => {
      await useAuth.getState().applyLanguageLocal('de');
      useAuth.getState().applyTimezoneLocal('Europe/Paris');
      useAuth.getState().applyThemeLocal('light');
      useAuth.getState().applyDistanceUnitLocal('miles');

      const d = useAuth.getState().driver;
      expect(d?.language).toBe('de');
      expect(d?.timezone).toBe('Europe/Paris');
      expect(d?.themePreference).toBe('light');
      expect(d?.distanceUnit).toBe('miles');
      expect(useAuth.getState().theme).toBe('light');
      expect(mockApplyTheme).toHaveBeenCalledWith('light');
      expect(mockLoadLanguage).toHaveBeenCalledWith('de');
      expect(localStorage.getItem('portal_language')).toBe('de');
      expect(localStorage.getItem('portal_timezone')).toBe('Europe/Paris');
      expect(localStorage.getItem('portal_theme')).toBe('light');
      expect(localStorage.getItem('portal_distance_unit')).toBe('miles');
      expect(mockPatch).not.toHaveBeenCalled();
    });
  });

  describe('preferences when signed out', () => {
    it('setters store locally and skip the API', async () => {
      await useAuth.getState().setLanguage('zh');
      await useAuth.getState().setTimezone('UTC');
      await useAuth.getState().setTheme('dark');
      await useAuth.getState().setDistanceUnit('km');

      expect(localStorage.getItem('portal_language')).toBe('zh');
      expect(localStorage.getItem('portal_timezone')).toBe('UTC');
      expect(localStorage.getItem('portal_theme')).toBe('dark');
      expect(localStorage.getItem('portal_distance_unit')).toBe('km');
      expect(useAuth.getState().theme).toBe('dark');
      expect(useAuth.getState().driver).toBeNull();
      expect(mockPatch).not.toHaveBeenCalled();
    });

    it('local appliers store locally and keep the driver null', async () => {
      await useAuth.getState().applyLanguageLocal('zh');
      useAuth.getState().applyTimezoneLocal('UTC');
      useAuth.getState().applyThemeLocal('dark');
      useAuth.getState().applyDistanceUnitLocal('km');

      expect(localStorage.getItem('portal_distance_unit')).toBe('km');
      expect(useAuth.getState().theme).toBe('dark');
      expect(useAuth.getState().driver).toBeNull();
    });
  });
});
