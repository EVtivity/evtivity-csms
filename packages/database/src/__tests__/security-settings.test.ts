// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PASSWORD_POLICY } from '@evtivity/lib/password-policy';
import { DEFAULT_SESSION_LIFETIMES } from '@evtivity/lib/session-lifetimes';

const mockSelect = vi.fn();
vi.mock('../config.js', () => ({ db: { select: mockSelect } }));
vi.mock('drizzle-orm', () => ({ like: vi.fn(() => ({ type: 'like' })) }));
vi.mock('../schema/settings.js', () => ({ settings: { key: 'key', value: 'value' } }));
const mockWarn = vi.fn();
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  createLogger: () => ({ warn: mockWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function rows(result: unknown[] | Error) {
  const chain: Record<string, unknown> = {};
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn(() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  );
  return chain;
}

beforeAll(async () => {
  await import('../lib/security-settings.js');
}, 30_000);

describe('security settings reader', () => {
  beforeEach(() => {
    vi.resetModules();
    mockSelect.mockReset();
    mockWarn.mockReset();
  });

  describe('getPasswordPolicy', () => {
    it('reads the stored fields and keeps the defaults for the others', async () => {
      mockSelect.mockReturnValue(
        rows([
          { key: 'security.password.minLength', value: 10 },
          { key: 'security.password.requireSymbol', value: true },
        ]),
      );
      const { getPasswordPolicy } = await import('../lib/security-settings.js');
      expect(await getPasswordPolicy()).toEqual({
        ...DEFAULT_PASSWORD_POLICY,
        minLength: 10,
        requireSymbol: true,
      });
    });

    it('reads every field when all are stored', async () => {
      mockSelect.mockReturnValue(
        rows([
          { key: 'security.password.minLength', value: 20 },
          { key: 'security.password.requireUppercase', value: false },
          { key: 'security.password.requireLowercase', value: false },
          { key: 'security.password.requireNumber', value: false },
          { key: 'security.password.requireSymbol', value: true },
        ]),
      );
      const { getPasswordPolicy } = await import('../lib/security-settings.js');
      expect(await getPasswordPolicy()).toEqual({
        minLength: 20,
        requireUppercase: false,
        requireLowercase: false,
        requireNumber: false,
        requireSymbol: true,
      });
    });

    it('gives the default policy when no row exists', async () => {
      mockSelect.mockReturnValue(rows([]));
      const { getPasswordPolicy } = await import('../lib/security-settings.js');
      expect(await getPasswordPolicy()).toEqual(DEFAULT_PASSWORD_POLICY);
    });

    it('clamps an out of range minimum length', async () => {
      mockSelect.mockReturnValue(rows([{ key: 'security.password.minLength', value: 3 }]));
      const { getPasswordPolicy } = await import('../lib/security-settings.js');
      expect((await getPasswordPolicy()).minLength).toBe(8);
    });

    it('gives the default policy when the read fails and nothing is cached', async () => {
      mockSelect.mockReturnValue(rows(new Error('db down')));
      const { getPasswordPolicy } = await import('../lib/security-settings.js');
      expect(await getPasswordPolicy()).toEqual(DEFAULT_PASSWORD_POLICY);
    });

    it('keeps the cached policy when a later read fails', async () => {
      mockSelect.mockReturnValueOnce(rows([{ key: 'security.password.minLength', value: 16 }]));
      const { getPasswordPolicy, clearSecuritySettingsCache } =
        await import('../lib/security-settings.js');
      expect((await getPasswordPolicy()).minLength).toBe(16);
      expect((await getPasswordPolicy()).minLength).toBe(16);
      expect(mockSelect).toHaveBeenCalledTimes(1);
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now() + 61_000);
        mockSelect.mockReturnValueOnce(rows(new Error('db down')));
        expect((await getPasswordPolicy()).minLength).toBe(16);
      } finally {
        vi.useRealTimers();
      }
      clearSecuritySettingsCache();
      mockSelect.mockReturnValueOnce(rows([]));
      expect((await getPasswordPolicy()).minLength).toBe(12);
    });
  });

  describe('readMfaConfig', () => {
    it('marks the stored switches as read', async () => {
      mockSelect.mockReturnValue(rows([{ key: 'security.mfa.emailEnabled', value: false }]));
      const { readMfaConfig } = await import('../lib/security-settings.js');
      expect(await readMfaConfig()).toEqual({
        config: {
          emailEnabled: false,
          totpEnabled: true,
          smsEnabled: false,
          required: 'off',
          requiredRoles: [],
          webauthnEnabled: true,
          passkeyLoginEnabled: false,
          requireDrivers: false,
        },
        fallback: false,
      });
    });

    it('reads required MFA for drivers', async () => {
      mockSelect.mockReturnValue(rows([{ key: 'security.mfa.requireDrivers', value: true }]));
      const { readMfaConfig } = await import('../lib/security-settings.js');
      expect((await readMfaConfig()).config.requireDrivers).toBe(true);
    });

    it('reads the passkey switches', async () => {
      mockSelect.mockReturnValue(
        rows([
          { key: 'security.mfa.webauthnEnabled', value: false },
          { key: 'security.mfa.passkeyLoginEnabled', value: true },
        ]),
      );
      const { readMfaConfig } = await import('../lib/security-settings.js');
      const reading = await readMfaConfig();
      expect(reading.config.webauthnEnabled).toBe(false);
      expect(reading.config.passkeyLoginEnabled).toBe(true);
    });

    it('reads the required MFA rule and its roles', async () => {
      mockSelect.mockReturnValue(
        rows([
          { key: 'security.mfa.required', value: 'roles' },
          { key: 'security.mfa.requiredRoles', value: ['admin'] },
        ]),
      );
      const { readMfaConfig } = await import('../lib/security-settings.js');
      const reading = await readMfaConfig();
      expect(reading.config.required).toBe('roles');
      expect(reading.config.requiredRoles).toEqual(['admin']);
    });

    it('marks the defaults as a fallback when the read fails and nothing is cached', async () => {
      mockSelect.mockReturnValue(rows(new Error('db down')));
      const { readMfaConfig, getMfaConfig } = await import('../lib/security-settings.js');
      expect(await readMfaConfig()).toEqual({
        config: {
          emailEnabled: true,
          totpEnabled: true,
          smsEnabled: false,
          required: 'off',
          requiredRoles: [],
          webauthnEnabled: true,
          passkeyLoginEnabled: false,
          requireDrivers: false,
        },
        fallback: true,
      });
      expect(await getMfaConfig()).toEqual({
        emailEnabled: true,
        totpEnabled: true,
        smsEnabled: false,
        required: 'off',
        requiredRoles: [],
        webauthnEnabled: true,
        passkeyLoginEnabled: false,
        requireDrivers: false,
      });
    });

    it('keeps the cached switches, not a fallback, when a later read fails', async () => {
      mockSelect.mockReturnValueOnce(rows([{ key: 'security.mfa.totpEnabled', value: false }]));
      const { readMfaConfig } = await import('../lib/security-settings.js');
      expect((await readMfaConfig()).fallback).toBe(false);
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now() + 61_000);
        mockSelect.mockReturnValueOnce(rows(new Error('db down')));
        expect(await readMfaConfig()).toEqual({
          config: {
            emailEnabled: true,
            totpEnabled: false,
            smsEnabled: false,
            required: 'off',
            requiredRoles: [],
            webauthnEnabled: true,
            passkeyLoginEnabled: false,
            requireDrivers: false,
          },
          fallback: false,
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('getSessionLifetimes', () => {
    it('gives the defaults when no row exists', async () => {
      mockSelect.mockReturnValue(rows([]));
      const { getSessionLifetimes } = await import('../lib/security-settings.js');
      expect(await getSessionLifetimes()).toEqual(DEFAULT_SESSION_LIFETIMES);
      expect(DEFAULT_SESSION_LIFETIMES).toEqual({
        operatorAccessMinutes: 60,
        operatorRefreshDays: 30,
        driverAccessMinutes: 60,
        driverRefreshDays: 30,
      });
    });

    it('reads the stored values and clamps them to their ranges', async () => {
      mockSelect.mockReturnValue(
        rows([
          { key: 'security.session.operatorAccessMinutes', value: 15 },
          { key: 'security.session.operatorRefreshDays', value: 120 },
          { key: 'security.session.driverAccessMinutes', value: 2 },
          { key: 'security.session.driverRefreshDays', value: 365 },
        ]),
      );
      const { getSessionLifetimes } = await import('../lib/security-settings.js');
      expect(await getSessionLifetimes()).toEqual({
        operatorAccessMinutes: 15,
        operatorRefreshDays: 90,
        driverAccessMinutes: 5,
        driverRefreshDays: 365,
      });
    });

    it('gives the defaults when the read fails and nothing is cached', async () => {
      mockSelect.mockReturnValue(rows(new Error('db down')));
      const { getSessionLifetimes } = await import('../lib/security-settings.js');
      expect(await getSessionLifetimes()).toEqual(DEFAULT_SESSION_LIFETIMES);
    });
  });

  it('still parses reCAPTCHA and MFA from the same read', async () => {
    mockSelect.mockReturnValue(
      rows([
        { key: 'security.mfa.smsEnabled', value: true },
        { key: 'security.password.minLength', value: 14 },
      ]),
    );
    const { getMfaConfig, getPasswordPolicy } = await import('../lib/security-settings.js');
    expect(await getMfaConfig()).toEqual({
      emailEnabled: true,
      totpEnabled: true,
      smsEnabled: true,
      required: 'off',
      requiredRoles: [],
      webauthnEnabled: true,
      passkeyLoginEnabled: false,
      requireDrivers: false,
    });
    expect((await getPasswordPolicy()).minLength).toBe(14);
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });
  it('warns with the key only when a stored value has the wrong type or is out of range', async () => {
    mockSelect.mockReturnValue(
      rows([
        { key: 'security.password.minLength', value: 200 },
        { key: 'security.password.requireSymbol', value: 'yes' },
        { key: 'security.password.requireNumber', value: false },
        { key: 'security.session.driverRefreshDays', value: '30' },
        { key: 'security.session.operatorAccessMinutes', value: 90 },
      ]),
    );
    const { getPasswordPolicy, getSessionLifetimes } = await import('../lib/security-settings.js');
    const policy = await getPasswordPolicy();
    expect(policy.minLength).toBe(64);
    expect(policy.requireSymbol).toBe(DEFAULT_PASSWORD_POLICY.requireSymbol);
    expect(policy.requireNumber).toBe(false);
    const lifetimes = await getSessionLifetimes();
    expect(lifetimes.driverRefreshDays).toBe(DEFAULT_SESSION_LIFETIMES.driverRefreshDays);
    expect(lifetimes.operatorAccessMinutes).toBe(90);

    const warned = mockWarn.mock.calls.map((call) => call[0] as Record<string, unknown>);
    expect(warned).toEqual([
      { key: 'security.password.minLength' },
      { key: 'security.password.requireSymbol' },
      { key: 'security.session.driverRefreshDays' },
    ]);
  });

  it('does not warn for valid or missing values', async () => {
    mockSelect.mockReturnValue(rows([{ key: 'security.password.minLength', value: 12 }]));
    const { getPasswordPolicy } = await import('../lib/security-settings.js');
    await getPasswordPolicy();
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
