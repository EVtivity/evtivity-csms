// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { hasMfaContact, mfaCodeRecipient, removesSmsMfaPhone } from '../lib/mfa-contact.js';

const contact = {
  email: 'jane@example.com',
  phone: '+12015550111',
  firstName: 'Jane',
  language: 'de',
};

describe('mfaCodeRecipient', () => {
  it('sends an SMS code to the phone only', () => {
    expect(mfaCodeRecipient('sms', contact)).toEqual({
      phone: '+12015550111',
      firstName: 'Jane',
      language: 'de',
    });
  });

  it('sends an email code to the email address only', () => {
    expect(mfaCodeRecipient('email', contact)).toEqual({
      email: 'jane@example.com',
      firstName: 'Jane',
      language: 'de',
    });
  });

  it('leaves out a missing contact and a missing first name', () => {
    expect(mfaCodeRecipient('sms', { ...contact, phone: null, firstName: null })).toEqual({
      language: 'de',
    });
    expect(mfaCodeRecipient('email', { ...contact, email: '' })).toEqual({
      firstName: 'Jane',
      language: 'de',
    });
  });
});

describe('hasMfaContact', () => {
  it('needs a phone for SMS and an email for email codes', () => {
    expect(hasMfaContact('sms', { email: 'a@b.c', phone: null })).toBe(false);
    expect(hasMfaContact('sms', { email: null, phone: ' ' })).toBe(false);
    expect(hasMfaContact('sms', { email: null, phone: '+1555' })).toBe(true);
    expect(hasMfaContact('email', { email: null, phone: '+1555' })).toBe(false);
    expect(hasMfaContact('email', { email: 'a@b.c', phone: null })).toBe(true);
  });

  it('needs no contact for TOTP', () => {
    expect(hasMfaContact('totp', { email: null, phone: null })).toBe(true);
  });
});

describe('removesSmsMfaPhone', () => {
  const sms = { mfaEnabled: true, mfaMethod: 'sms' };
  it('is true when an active SMS factor would lose its phone', () => {
    expect(removesSmsMfaPhone(null, sms)).toBe(true);
    expect(removesSmsMfaPhone(' ', sms)).toBe(true);
  });

  it('is false for a new phone, no change, or another method', () => {
    expect(removesSmsMfaPhone('+1555', sms)).toBe(false);
    expect(removesSmsMfaPhone(undefined, sms)).toBe(false);
    expect(removesSmsMfaPhone(null, { mfaEnabled: true, mfaMethod: 'totp' })).toBe(false);
    expect(removesSmsMfaPhone(null, { mfaEnabled: false, mfaMethod: null })).toBe(false);
  });
});
