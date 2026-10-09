// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { rowsQueue } = vi.hoisted(() => ({ rowsQueue: [] as unknown[][] }));

function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy']) c[m] = vi.fn(() => c);
  c['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(rowsQueue.shift() ?? []).then(resolve);
  return c;
}

vi.mock('@evtivity/database', () => ({
  db: { select: vi.fn(() => chain()) },
  drivers: { phone: 'phone', registrationSource: 'source', createdAt: 'created_at' },
  userTokens: { driverId: 'driver_id', type: 'type', createdAt: 'created_at' },
}));

import {
  PHONE_REGISTRATIONS_PER_DAY,
  VERIFICATION_EMAILS_PER_DAY,
  VERIFICATION_RESEND_INTERVAL_SECONDS,
  isPhoneRegistrationLimited,
  registrationPhone,
  verificationResendRetryAfter,
} from '../lib/signup-limits.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const ago = (seconds: number): { createdAt: Date } => ({
  createdAt: new Date(NOW.getTime() - seconds * 1000),
});

beforeEach(() => {
  rowsQueue.length = 0;
});

describe('signup limits', () => {
  it('uses one email a minute, five a day, and three registrations per phone a day', () => {
    expect(VERIFICATION_RESEND_INTERVAL_SECONDS).toBe(60);
    expect(VERIFICATION_EMAILS_PER_DAY).toBe(5);
    expect(PHONE_REGISTRATIONS_PER_DAY).toBe(3);
  });

  it('normalizes the registration phone so formatting variants match', () => {
    expect(registrationPhone('(555) 123-4567')).toBe('+15551234567');
    expect(registrationPhone(' 555.123.4567 ')).toBe('+15551234567');
    expect(registrationPhone('+49 30 1234567')).toBe('+49301234567');
    expect(registrationPhone('')).toBeNull();
    expect(registrationPhone(undefined)).toBeNull();
  });

  it('limits a phone at the third registration in 24 hours', async () => {
    rowsQueue.push([{ n: 2 }]);
    expect(await isPhoneRegistrationLimited('+15551234567', NOW)).toBe(false);
    rowsQueue.push([{ n: 3 }]);
    expect(await isPhoneRegistrationLimited('+15551234567', NOW)).toBe(true);
  });

  it('allows a resend when no email went out in the last 24 hours', async () => {
    rowsQueue.push([]);
    expect(await verificationResendRetryAfter('drv_1', NOW)).toBeNull();
  });

  it('asks to wait out the minute after the last email', async () => {
    rowsQueue.push([ago(20)]);
    expect(await verificationResendRetryAfter('drv_1', NOW)).toBe(40);
    rowsQueue.push([ago(61)]);
    expect(await verificationResendRetryAfter('drv_1', NOW)).toBeNull();
  });

  it('asks to wait until the oldest of five emails is 24 hours old', async () => {
    rowsQueue.push([ago(23 * 3600), ago(3000), ago(2000), ago(1000), ago(120)]);
    expect(await verificationResendRetryAfter('drv_1', NOW)).toBe(3600);
  });

  it('allows the fifth email of the day', async () => {
    rowsQueue.push([ago(3000), ago(2000), ago(1000), ago(120)]);
    expect(await verificationResendRetryAfter('drv_1', NOW)).toBeNull();
  });
});
