// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { TFunction } from 'i18next';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: { min?: number }) =>
      opts?.min != null ? `${key}:${String(opts.min)}` : key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

import { PasswordRequirements } from '../PasswordRequirements';
import { passwordRulesMessage } from '@/lib/password-rules';

afterEach(() => {
  cleanup();
});

function rule(name: string): HTMLElement {
  const el = screen.getByTestId('password-requirements').querySelector(`[data-rule="${name}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`no rule ${name}`);
  return el;
}

describe('PasswordRequirements', () => {
  it('lists every API rule (CSMS) with the minimum length', () => {
    render(<PasswordRequirements id="req" password="" showUnmet={false} />);
    expect(screen.getByText('validation.passwordNeeds')).toBeTruthy();
    expect(screen.getByText('validation.passwordRule.minLength:12')).toBeTruthy();
    expect(screen.getByText('validation.passwordRule.uppercase:12')).toBeTruthy();
    expect(screen.getByText('validation.passwordRule.lowercase:12')).toBeTruthy();
    expect(screen.getByText('validation.passwordRule.number:12')).toBeTruthy();
    expect(screen.getByTestId('password-requirements').id).toBe('req');
  });

  it('marks the rules the password meets as it changes', () => {
    const { rerender } = render(<PasswordRequirements id="req" password="abc" showUnmet={false} />);
    expect(rule('lowercase').dataset.met).toBe('true');
    expect(rule('uppercase').dataset.met).toBe('false');
    expect(rule('lowercase').className).toContain('text-success');
    expect(rule('uppercase').className).toContain('text-muted-foreground');

    rerender(<PasswordRequirements id="req" password="Abcdefghijk1" showUnmet={false} />);
    for (const name of ['minLength', 'uppercase', 'lowercase', 'number']) {
      expect(rule(name).dataset.met).toBe('true');
    }
  });

  it('turns unmet rules destructive after a submit attempt', () => {
    render(<PasswordRequirements id="req" password="abc" showUnmet />);
    expect(rule('uppercase').className).toContain('text-destructive');
    expect(rule('lowercase').className).toContain('text-success');
  });
});

describe('passwordRulesMessage', () => {
  const t = ((key: string, opts?: Record<string, unknown>) =>
    key === 'validation.passwordMissing'
      ? `needs ${String(opts?.['rules'])}`
      : key.replace('validation.passwordRule.', '')) as unknown as TFunction;

  it('returns null for a valid password', () => {
    expect(passwordRulesMessage('Abcdefghijk1', t, 'en')).toBeNull();
  });

  it('names every missing rule as a list in the UI language', () => {
    expect(passwordRulesMessage('abcdefghijkl', t, 'en')).toBe('needs uppercase and number');
    expect(passwordRulesMessage('abc', t, 'en')).toBe('needs minLength, uppercase, and number');
  });
});
