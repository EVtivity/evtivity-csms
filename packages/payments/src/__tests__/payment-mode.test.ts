// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { classifySessionPayment } from '../payment-mode.js';
import type { SessionPaymentFacts } from '../payment-mode.js';

const none: SessionPaymentFacts = {
  isRoaming: false,
  freeVend: false,
  prepaid: false,
  account: false,
  driverId: null,
  guestSession: false,
};

describe('classifySessionPayment', () => {
  it('classifies each mode', () => {
    expect(classifySessionPayment({ ...none, isRoaming: true })).toBe('roaming');
    expect(classifySessionPayment({ ...none, freeVend: true })).toBe('free_vend');
    expect(classifySessionPayment({ ...none, prepaid: true })).toBe('prepaid');
    expect(classifySessionPayment({ ...none, account: true, driverId: 'drv_1' })).toBe('account');
    expect(classifySessionPayment({ ...none, driverId: 'drv_1' })).toBe('card');
    expect(classifySessionPayment({ ...none, guestSession: true })).toBe('guest');
    expect(classifySessionPayment(none)).toBe('anonymous');
  });

  it('applies the precedence roaming, free vend, prepaid, account, card, guest', () => {
    const all: SessionPaymentFacts = {
      isRoaming: true,
      freeVend: true,
      prepaid: true,
      account: true,
      driverId: 'drv_1',
      guestSession: true,
    };
    expect(classifySessionPayment(all)).toBe('roaming');
    expect(classifySessionPayment({ ...all, isRoaming: false })).toBe('free_vend');
    expect(classifySessionPayment({ ...all, isRoaming: false, freeVend: false })).toBe('prepaid');
    expect(
      classifySessionPayment({ ...all, isRoaming: false, freeVend: false, prepaid: false }),
    ).toBe('account');
    expect(
      classifySessionPayment({
        ...all,
        isRoaming: false,
        freeVend: false,
        prepaid: false,
        account: false,
      }),
    ).toBe('card');
    expect(
      classifySessionPayment({
        ...all,
        isRoaming: false,
        freeVend: false,
        prepaid: false,
        driverId: null,
      }),
    ).toBe('guest');
  });

  it('needs a driver for account', () => {
    expect(classifySessionPayment({ ...none, account: true })).toBe('anonymous');
    expect(classifySessionPayment({ ...none, account: true, guestSession: true })).toBe('guest');
  });
});
