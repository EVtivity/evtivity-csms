// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { create } from 'zustand';
import { api, ApiError } from './api';
import { loadLanguage } from '../i18n/index';
import { applyTheme, type Theme } from './theme';

interface Driver {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  language: string;
  timezone: string;
  themePreference: Theme;
  distanceUnit: 'miles' | 'km';
  isActive: boolean;
  emailVerified: boolean;
}

interface LoginResponse {
  driver: Driver;
}

interface MfaPendingResponse {
  mfaRequired: true;
  mfaMethod: string;
  mfaToken: string;
  challengeId?: string;
}

interface MfaPendingState {
  mfaRequired: true;
  mfaMethod: string;
  mfaToken: string;
  challengeId?: string;
}

interface AuthState {
  driver: Driver | null;
  isAuthenticated: boolean;
  isHydrating: boolean;
  apiDown: boolean;
  theme: Theme;
  mfaPending: MfaPendingState | null;
  login: (email: string, password: string, recaptchaToken?: string) => Promise<void>;
  register: (data: {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
    phone?: string;
    recaptchaToken?: string;
  }) => Promise<void>;
  completeMfaLogin: (driver: Driver) => Promise<void>;
  clearMfaPending: () => void;
  logout: () => Promise<void>;
  hydrate: () => void;
  retryConnection: () => void;
  setLanguage: (lang: string) => Promise<void>;
  setTimezone: (tz: string) => Promise<void>;
  setTheme: (theme: Theme) => Promise<void>;
  setDistanceUnit: (unit: 'miles' | 'km') => Promise<void>;
}

export const useAuth = create<AuthState>((set, get) => ({
  driver: null,
  isAuthenticated: false,
  isHydrating: true,
  apiDown: false,
  theme: localStorage.getItem('portal_theme') === 'dark' ? 'dark' : 'light',
  mfaPending: null,

  login: async (email: string, password: string, recaptchaToken?: string) => {
    const body: Record<string, string> = { email, password };
    if (recaptchaToken != null) body['recaptchaToken'] = recaptchaToken;
    const data = await api.post<LoginResponse | MfaPendingResponse>('/v1/portal/auth/login', body);

    if ('mfaRequired' in data) {
      set({
        mfaPending: {
          mfaRequired: true,
          mfaMethod: data.mfaMethod,
          mfaToken: data.mfaToken,
          ...(data.challengeId != null ? { challengeId: data.challengeId } : {}),
        },
      });
      return;
    }

    const loginData = data;
    localStorage.setItem('portal_language', loginData.driver.language);
    localStorage.setItem('portal_timezone', loginData.driver.timezone);
    localStorage.setItem('portal_theme', loginData.driver.themePreference);
    localStorage.setItem('portal_distance_unit', loginData.driver.distanceUnit);
    applyTheme(loginData.driver.themePreference);
    await loadLanguage(loginData.driver.language);
    set({
      driver: loginData.driver,
      theme: loginData.driver.themePreference,
      isAuthenticated: true,
      mfaPending: null,
    });
    api.post('/v1/portal/access-logs', { action: 'login' }).catch(() => {});
  },

  register: async (body) => {
    const data = await api.post<LoginResponse>('/v1/portal/auth/register', body);
    localStorage.setItem('portal_language', data.driver.language);
    localStorage.setItem('portal_timezone', data.driver.timezone);
    localStorage.setItem('portal_theme', data.driver.themePreference);
    localStorage.setItem('portal_distance_unit', data.driver.distanceUnit);
    applyTheme(data.driver.themePreference);
    await loadLanguage(data.driver.language);
    set({
      driver: data.driver,
      theme: data.driver.themePreference,
      isAuthenticated: true,
    });
  },

  completeMfaLogin: async (driver: Driver) => {
    localStorage.setItem('portal_language', driver.language);
    localStorage.setItem('portal_timezone', driver.timezone);
    localStorage.setItem('portal_theme', driver.themePreference);
    localStorage.setItem('portal_distance_unit', driver.distanceUnit);
    applyTheme(driver.themePreference);
    await loadLanguage(driver.language);
    set({
      driver,
      theme: driver.themePreference,
      isAuthenticated: true,
      mfaPending: null,
    });
    api.post('/v1/portal/access-logs', { action: 'login' }).catch(() => {});
  },

  clearMfaPending: () => {
    set({ mfaPending: null });
  },

  logout: async () => {
    api.post('/v1/portal/access-logs', { action: 'logout' }).catch(() => {});
    try {
      await api.post('/v1/portal/auth/logout', {});
    } catch {
      // Clear state even if the server call fails
    }
    // Prevent auto-login from firing after logout
    sessionStorage.setItem('noAutoLogin', 'true');
    // Clear all portal localStorage keys
    localStorage.removeItem('evtivity-driver-location');
    localStorage.removeItem('portal_language');
    localStorage.removeItem('portal_timezone');
    localStorage.removeItem('portal_theme');
    localStorage.removeItem('portal_distance_unit');
    set({ driver: null, isAuthenticated: false });
  },

  hydrate: () => {
    api
      .get<Driver>('/v1/portal/auth/me')
      .then((driver) => {
        localStorage.setItem('portal_language', driver.language);
        localStorage.setItem('portal_timezone', driver.timezone);
        localStorage.setItem('portal_theme', driver.themePreference);
        applyTheme(driver.themePreference);
        void loadLanguage(driver.language);
        set({ driver, isAuthenticated: true, isHydrating: false, theme: driver.themePreference });
      })
      .catch((err: unknown) => {
        if (err instanceof TypeError || (err instanceof ApiError && err.isServerDown)) {
          set({ apiDown: true, isHydrating: false });
          return;
        }
        set({ driver: null, isAuthenticated: false, isHydrating: false });
      });
  },

  retryConnection: () => {
    set({ apiDown: false, isHydrating: true });
    get().hydrate();
  },

  setLanguage: async (lang: string) => {
    localStorage.setItem('portal_language', lang);
    await loadLanguage(lang);
    const driver = get().driver;
    if (driver != null) {
      set({ driver: { ...driver, language: lang } });
      await api.patch('/v1/portal/driver/profile', { language: lang });
    }
  },

  setTimezone: async (tz: string) => {
    localStorage.setItem('portal_timezone', tz);
    const driver = get().driver;
    if (driver != null) {
      set({ driver: { ...driver, timezone: tz } });
      await api.patch('/v1/portal/driver/profile', { timezone: tz });
    }
  },

  setTheme: async (theme: Theme) => {
    localStorage.setItem('portal_theme', theme);
    applyTheme(theme);
    set({ theme });
    const driver = get().driver;
    if (driver != null) {
      set({ driver: { ...driver, themePreference: theme } });
      await api.patch('/v1/portal/driver/profile', { themePreference: theme });
    }
  },

  setDistanceUnit: async (unit: 'miles' | 'km') => {
    localStorage.setItem('portal_distance_unit', unit);
    const driver = get().driver;
    if (driver != null) {
      set({ driver: { ...driver, distanceUnit: unit } });
      await api.patch('/v1/portal/driver/profile', { distanceUnit: unit });
    }
  },
}));
