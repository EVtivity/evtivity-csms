// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { DEFAULT_PASSWORD_POLICY, PASSWORD_MAX_LENGTH } from '@evtivity/lib/password-policy';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: { min?: number }) =>
      opts?.min != null ? `${key}:${String(opts.min)}` : key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

import { PasswordRequirements } from '../PasswordRequirements';
import { ApiError } from '@/lib/api';
import { passwordRulesMessage, weakPasswordMissing } from '@/lib/password-rules';

const STRICT = { ...DEFAULT_PASSWORD_POLICY, minLength: 14, requireSymbol: true };

afterEach(() => {
  cleanup();
});

function rule(name: string): HTMLElement {
  const el = screen.getByTestId('password-requirements').querySelector(`[data-rule="${name}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`no rule ${name}`);
  return el;
}

function ruleIds(): (string | undefined)[] {
  return Array.from(
    screen.getByTestId('password-requirements').querySelectorAll<HTMLElement>('[data-rule]'),
    (el) => el.dataset.rule,
  );
}

describe('PasswordRequirements', () => {
  it('lists the rules of the default policy with its minimum length', () => {
    render(
      <PasswordRequirements
        id="req"
        password=""
        policy={DEFAULT_PASSWORD_POLICY}
        showUnmet={false}
      />,
    );
    expect(screen.getByText('validation.passwordNeeds')).toBeTruthy();
    expect(ruleIds()).toEqual(['minLength', 'uppercase', 'lowercase', 'number']);
    expect(
      screen.getByText(
        `validation.passwordRule.minLength:${String(DEFAULT_PASSWORD_POLICY.minLength)}`,
      ),
    ).toBeTruthy();
    expect(screen.getByTestId('password-requirements').id).toBe('req');
  });

  it('lists five rules for a policy with 14 characters and a symbol, and marks the symbol met', () => {
    render(<PasswordRequirements id="req" password="Abcdefghijk1!x" policy={STRICT} showUnmet />);
    expect(ruleIds()).toEqual(['minLength', 'uppercase', 'lowercase', 'number', 'symbol']);
    expect(screen.getByText('validation.passwordRule.minLength:14')).toBeTruthy();
    expect(rule('symbol').dataset.met).toBe('true');
    expect(rule('minLength').dataset.met).toBe('true');
  });

  it('leaves out rules the policy turns off', () => {
    render(
      <PasswordRequirements
        id="req"
        password=""
        policy={{ ...DEFAULT_PASSWORD_POLICY, requireUppercase: false, requireNumber: false }}
        showUnmet={false}
      />,
    );
    expect(ruleIds()).toEqual(['minLength', 'lowercase']);
  });

  it('shows the maximum length only once the password exceeds it', () => {
    const { rerender } = render(
      <PasswordRequirements
        id="req"
        password="Abcdefghijk1"
        policy={DEFAULT_PASSWORD_POLICY}
        showUnmet
      />,
    );
    expect(ruleIds()).not.toContain('maxLength');
    rerender(
      <PasswordRequirements
        id="req"
        password={`Abcdefghijk1${'x'.repeat(PASSWORD_MAX_LENGTH)}`}
        policy={DEFAULT_PASSWORD_POLICY}
        showUnmet
      />,
    );
    expect(rule('maxLength').dataset.met).toBe('false');
  });

  it('marks the rules a WEAK_PASSWORD reply named as unmet, even ones the page policy lacks', () => {
    render(
      <PasswordRequirements
        id="req"
        password="Abcdefghijk1"
        policy={DEFAULT_PASSWORD_POLICY}
        showUnmet
        serverMissing={['minLength', 'symbol']}
      />,
    );
    expect(ruleIds()).toEqual(['minLength', 'uppercase', 'lowercase', 'number', 'symbol']);
    expect(rule('minLength').dataset.met).toBe('false');
    expect(rule('symbol').dataset.met).toBe('false');
    expect(rule('symbol').className).toContain('text-destructive');
    expect(rule('uppercase').dataset.met).toBe('true');
  });

  it('marks the rules the password meets as it changes', () => {
    const { rerender } = render(
      <PasswordRequirements
        id="req"
        password="abc"
        policy={DEFAULT_PASSWORD_POLICY}
        showUnmet={false}
      />,
    );
    expect(rule('lowercase').dataset.met).toBe('true');
    expect(rule('uppercase').dataset.met).toBe('false');
    expect(rule('lowercase').className).toContain('text-success');
    expect(rule('uppercase').className).toContain('text-muted-foreground');

    rerender(
      <PasswordRequirements
        id="req"
        password="Abcdefghijk1"
        policy={DEFAULT_PASSWORD_POLICY}
        showUnmet={false}
      />,
    );
    for (const name of ['minLength', 'uppercase', 'lowercase', 'number']) {
      expect(rule(name).dataset.met).toBe('true');
    }
  });

  it('turns unmet rules destructive after a submit attempt', () => {
    render(
      <PasswordRequirements id="req" password="abc" policy={DEFAULT_PASSWORD_POLICY} showUnmet />,
    );
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
    expect(passwordRulesMessage('Abcdefghijk1', DEFAULT_PASSWORD_POLICY, t, 'en')).toBeNull();
  });

  it('names every missing rule as a list in the UI language', () => {
    expect(passwordRulesMessage('abcdefghijkl', DEFAULT_PASSWORD_POLICY, t, 'en')).toBe(
      'needs uppercase and number',
    );
    expect(passwordRulesMessage('abc', DEFAULT_PASSWORD_POLICY, t, 'en')).toBe(
      'needs minLength, uppercase, and number',
    );
  });

  it('checks the policy it is given', () => {
    expect(passwordRulesMessage('Abcdefghijk1', STRICT, t, 'en')).toBe(
      'needs minLength and symbol',
    );
    expect(passwordRulesMessage('Abcdefghijk1!x', STRICT, t, 'en')).toBeNull();
  });

  it('names the rules a WEAK_PASSWORD reply named, or the generic text for an empty list', () => {
    expect(passwordRulesMessage('Abcdefghijk1', DEFAULT_PASSWORD_POLICY, t, 'en', ['symbol'])).toBe(
      'needs symbol',
    );
    expect(passwordRulesMessage('Abcdefghijk1', DEFAULT_PASSWORD_POLICY, t, 'en', [])).toBe(
      'errors.WEAK_PASSWORD',
    );
  });

  it('names the maximum length for a password over it', () => {
    expect(
      passwordRulesMessage(
        `Abcdefghijk1${'x'.repeat(PASSWORD_MAX_LENGTH)}`,
        DEFAULT_PASSWORD_POLICY,
        t,
        'en',
      ),
    ).toBe('needs maxLength');
  });
});

describe('weakPasswordMissing', () => {
  it('reads the missing rules of a WEAK_PASSWORD reply in rule order, dropping unknown ids', () => {
    const err = new ApiError(400, {
      code: 'WEAK_PASSWORD',
      missing: ['symbol', 'bogus', 'minLength'],
    });
    expect(weakPasswordMissing(err)).toEqual(['minLength', 'symbol']);
  });

  it('returns an empty list for a WEAK_PASSWORD reply without missing, null for other errors', () => {
    expect(weakPasswordMissing(new ApiError(400, { code: 'WEAK_PASSWORD' }))).toEqual([]);
    expect(weakPasswordMissing(new ApiError(400, { code: 'VALIDATION_ERROR' }))).toBeNull();
    expect(weakPasswordMissing(new Error('network'))).toBeNull();
  });
});
