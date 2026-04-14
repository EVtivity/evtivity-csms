// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { create } from 'zustand';
import { api, ApiError } from './api';
import { loadLanguage } from '../i18n';
import { applyTheme, type Theme } from './theme';

export class MustResetPasswordError extends Error {
  constructor() {
    super('must_reset_password');
    this.name = 'MustResetPasswordError';
  }
}

interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  language: string;
  timezone: string;
  themePreference: Theme;
}

interface LoginResponse {
  token: string;
  user: User;
  role: { id: string; name: string } | null;
}

interface MustResetPasswordResponse {
  mustResetPassword: true;
}

interface MeResponse extends User {
  roleId: string;
  role: { id: string; name: string } | null;
  themePreference: Theme;
  permissions: string[];
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
  user: User | null;
  role: string | null;
  permissions: string[];
  theme: Theme;
  isAuthenticated: boolean;
  isHydrating: boolean;
  apiDown: boolean;
  mfaPending: MfaPendingState | null;
  login: (email: string, password: string, recaptchaToken?: string) => Promise<void>;
  completeMfaLogin: (user: User, role: string | null) => Promise<void>;
  clearMfaPending: () => void;
  logout: () => void;
  hydrate: () => void;
  retryConnection: () => void;
  setLanguage: (language: string) => Promise<void>;
  setTimezone: (timezone: string) => Promise<void>;
  setTheme: (theme: Theme) => Promise<void>;
}

function getInitialState(): {
  role: string | null;
  theme: Theme;
  isAuthenticated: boolean;
} {
  const storedTheme = localStorage.getItem('theme');
  const theme: Theme = storedTheme === 'dark' ? 'dark' : 'light';
  return { role: null, theme, isAuthenticated: false };
}

const initial = getInitialState();

/**
 * Check if a user has a specific permission.
 * Write implies read for the same resource.
 */
function hasPermissionCheck(userPermissions: string[], required: string): boolean {
  if (userPermissions.includes(required)) return true;
  if (required.endsWith(':read')) {
    const writeVersion = required.replace(':read', ':write');
    if (userPermissions.includes(writeVersion)) return true;
  }
  return false;
}

/**
 * Hook: returns true if the current user has the given permission.
 * Write implies read for the same resource.
 */
export function useHasPermission(perm: string): boolean {
  const permissions = useAuth((s) => s.permissions);
  return hasPermissionCheck(permissions, perm);
}

/**
 * Hook: returns true if the current user has any of the given permissions.
 */
export function useHasAnyPermission(perms: string[]): boolean {
  const permissions = useAuth((s) => s.permissions);
  return perms.some((p) => hasPermissionCheck(permissions, p));
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  role: initial.role,
  permissions: [],
  theme: initial.theme,
  isAuthenticated: initial.isAuthenticated,
  isHydrating: true,
  apiDown: false,
  mfaPending: null,

  login: async (email: string, password: string, recaptchaToken?: string) => {
    const body: Record<string, string> = { email, password };
    if (recaptchaToken != null) body['recaptchaToken'] = recaptchaToken;
    const data = await api.post<LoginResponse | MfaPendingResponse | MustResetPasswordResponse>(
      '/v1/auth/login',
      body,
    );

    if ('mustResetPassword' in data) {
      throw new MustResetPasswordError();
    }

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
    localStorage.setItem('role', loginData.role?.name ?? '');
    localStorage.setItem('language', loginData.user.language);
    localStorage.setItem('timezone', loginData.user.timezone);
    localStorage.setItem('theme', loginData.user.themePreference);
    applyTheme(loginData.user.themePreference);
    await loadLanguage(loginData.user.language);

    // Fetch permissions after login
    const perms = await api.get<string[]>('/v1/users/me/permissions').catch(() => [] as string[]);

    set({
      user: loginData.user,
      role: loginData.role?.name ?? null,
      permissions: perms,
      theme: loginData.user.themePreference,
      isAuthenticated: true,
      mfaPending: null,
    });
    api.post('/v1/access-logs', { action: 'login' }).catch(() => {});
  },

  completeMfaLogin: async (user: User, role: string | null) => {
    localStorage.setItem('role', role ?? '');
    localStorage.setItem('language', user.language);
    localStorage.setItem('timezone', user.timezone);
    localStorage.setItem('theme', user.themePreference);
    applyTheme(user.themePreference);
    await loadLanguage(user.language);

    const perms = await api.get<string[]>('/v1/users/me/permissions').catch(() => [] as string[]);

    set({
      user,
      role,
      permissions: perms,
      theme: user.themePreference,
      isAuthenticated: true,
      mfaPending: null,
    });
    api.post('/v1/access-logs', { action: 'login' }).catch(() => {});
  },

  clearMfaPending: () => {
    set({ mfaPending: null });
  },

  logout: () => {
    api.post('/v1/access-logs', { action: 'logout' }).catch(() => {});
    api.post('/v1/auth/logout', {}).catch(() => {});
    localStorage.removeItem('role');
    sessionStorage.setItem('noAutoLogin', 'true');
    set({ user: null, role: null, permissions: [], isAuthenticated: false });
  },

  hydrate: () => {
    set({ isHydrating: true });
    api
      .get<MeResponse>('/v1/users/me')
      .then((me) => {
        localStorage.setItem('role', me.role?.name ?? '');
        localStorage.setItem('language', me.language);
        localStorage.setItem('timezone', me.timezone);
        localStorage.setItem('theme', me.themePreference);
        applyTheme(me.themePreference);
        void loadLanguage(me.language);
        set({
          user: {
            id: me.id,
            email: me.email,
            firstName: me.firstName,
            lastName: me.lastName,
            language: me.language,
            timezone: me.timezone,
            themePreference: me.themePreference,
          },
          theme: me.themePreference,
          role: me.role?.name ?? null,
          permissions: me.permissions,
          isAuthenticated: true,
          isHydrating: false,
        });
      })
      .catch((err: unknown) => {
        // Network error or gateway error (API unreachable)
        if (err instanceof TypeError || (err instanceof ApiError && err.isServerDown)) {
          set({ apiDown: true, isHydrating: false });
          return;
        }
        localStorage.removeItem('role');
        localStorage.removeItem('language');
        set({
          user: null,
          role: null,
          permissions: [],
          isAuthenticated: false,
          isHydrating: false,
        });
      });
  },

  retryConnection: () => {
    set({ apiDown: false, isHydrating: true });
    get().hydrate();
  },

  setLanguage: async (language: string) => {
    localStorage.setItem('language', language);
    await loadLanguage(language);
    const user = get().user;
    if (user != null) {
      set({ user: { ...user, language } });
      await api.patch(`/v1/users/${user.id}`, { language });
    }
  },

  setTimezone: async (timezone: string) => {
    localStorage.setItem('timezone', timezone);
    const user = get().user;
    if (user != null) {
      set({ user: { ...user, timezone } });
      await api.patch(`/v1/users/${user.id}`, { timezone });
    }
  },

  setTheme: async (theme: Theme) => {
    localStorage.setItem('theme', theme);
    applyTheme(theme);
    set({ theme });
    const user = get().user;
    if (user != null) {
      set({ user: { ...user, themePreference: theme } });
      await api.patch(`/v1/users/${user.id}`, { themePreference: theme });
    }
  },
}));
