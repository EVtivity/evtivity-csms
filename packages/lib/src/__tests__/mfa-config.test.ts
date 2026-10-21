// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MFA_CONFIG,
  isMfaRequiredForRole,
  normalizeMfaConfig,
  normalizeMfaRequiredRoles,
} from '../mfa-config.js';

describe('normalizeMfaConfig', () => {
  it('turns email and TOTP on and SMS off when nothing is stored', () => {
    expect(normalizeMfaConfig({})).toEqual({
      emailEnabled: true,
      totpEnabled: true,
      smsEnabled: false,
      required: 'off',
      requiredRoles: [],
      webauthnEnabled: true,
      passkeyLoginEnabled: false,
      requireDrivers: false,
    });
    expect(DEFAULT_MFA_CONFIG).toEqual(normalizeMfaConfig({}));
  });

  it('keeps the stored switches', () => {
    expect(
      normalizeMfaConfig({ emailEnabled: false, totpEnabled: false, smsEnabled: true }),
    ).toEqual({
      emailEnabled: false,
      totpEnabled: false,
      smsEnabled: true,
      required: 'off',
      requiredRoles: [],
      webauthnEnabled: true,
      passkeyLoginEnabled: false,
      requireDrivers: false,
    });
  });

  it('treats only false as off for email and TOTP, and only true as on for SMS', () => {
    expect(
      normalizeMfaConfig({ emailEnabled: 'false', totpEnabled: null, smsEnabled: 'true' }),
    ).toEqual({
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

  it('keeps a stored required value and its roles', () => {
    expect(normalizeMfaConfig({ required: 'all' }).required).toBe('all');
    const config = normalizeMfaConfig({ required: 'roles', requiredRoles: ['admin', 'operator'] });
    expect(config.required).toBe('roles');
    expect(config.requiredRoles).toEqual(['admin', 'operator']);
  });

  it('keeps WebAuthn on and passkey sign-in off unless stored otherwise', () => {
    const stored = normalizeMfaConfig({ webauthnEnabled: false, passkeyLoginEnabled: true });
    expect(stored.webauthnEnabled).toBe(false);
    expect(stored.passkeyLoginEnabled).toBe(true);
    const loose = normalizeMfaConfig({ webauthnEnabled: 'false', passkeyLoginEnabled: 'true' });
    expect(loose.webauthnEnabled).toBe(true);
    expect(loose.passkeyLoginEnabled).toBe(false);
  });

  it('requires MFA for drivers only when true is stored', () => {
    expect(normalizeMfaConfig({ requireDrivers: true }).requireDrivers).toBe(true);
    expect(normalizeMfaConfig({ requireDrivers: 'true' }).requireDrivers).toBe(false);
    expect(normalizeMfaConfig({}).requireDrivers).toBe(false);
  });

  it('treats an unknown required value as off', () => {
    expect(normalizeMfaConfig({ required: 'everyone' }).required).toBe('off');
    expect(normalizeMfaConfig({ required: true }).required).toBe('off');
  });
});

describe('normalizeMfaRequiredRoles', () => {
  it('keeps unique non-empty strings, trimmed', () => {
    expect(normalizeMfaRequiredRoles([' admin ', 'admin', '', 3, 'viewer'])).toEqual([
      'admin',
      'viewer',
    ]);
  });

  it('answers an empty list for anything that is not an array', () => {
    expect(normalizeMfaRequiredRoles('admin')).toEqual([]);
    expect(normalizeMfaRequiredRoles(null)).toEqual([]);
  });
});

describe('isMfaRequiredForRole', () => {
  const base = normalizeMfaConfig({});

  it('requires nobody while off', () => {
    expect(isMfaRequiredForRole({ ...base, requiredRoles: ['admin'] }, 'admin')).toBe(false);
  });

  it('requires everyone with all', () => {
    expect(isMfaRequiredForRole({ ...base, required: 'all' }, 'viewer')).toBe(true);
    expect(isMfaRequiredForRole({ ...base, required: 'all' }, null)).toBe(true);
  });

  it('requires only the listed roles with roles', () => {
    const config = { ...base, required: 'roles' as const, requiredRoles: ['admin'] };
    expect(isMfaRequiredForRole(config, 'admin')).toBe(true);
    expect(isMfaRequiredForRole(config, 'operator')).toBe(false);
    expect(isMfaRequiredForRole(config, null)).toBe(false);
  });
});
