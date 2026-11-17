// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

const { mockClaim, mockDispatch } = vi.hoisted(() => ({
  mockClaim: vi.fn(),
  mockDispatch: vi.fn(),
}));

vi.mock('../server/notification-dispatcher.js', () => ({
  dispatchDriverNotification: mockDispatch,
  ALL_TEMPLATES_DIRS: ['templates'],
}));

vi.mock('@evtivity/database', () => ({
  claimCardMonthlyLimitNotice: mockClaim,
  getCompanyCurrency: vi.fn().mockResolvedValue('EUR'),
}));

import {
  CARD_MONTHLY_LIMIT_EVENT,
  sendCardMonthlyLimitNotice,
  sendSessionCardMonthlyLimitNotice,
} from '../server/card-limit-notice.js';

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

function sqlReturning(rows: unknown[]): postgres.Sql {
  return vi.fn(() => Promise.resolve(rows)) as unknown as postgres.Sql;
}

describe('RFID card monthly limit notice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatch.mockResolvedValue({ delivered: [] });
  });

  it('sends the member the notice with the card, fleet and limit', async () => {
    mockClaim.mockResolvedValueOnce({
      driverId: 'drv_1',
      idToken: 'CARD-1',
      tokenType: 'ISO14443',
      label: null,
      fleetName: 'Northwind',
      limitCents: 5000,
    });
    const sql = sqlReturning([]);
    await sendCardMonthlyLimitNotice({ sql, logger }, 'dtk_1', 'CS-1');
    expect(mockClaim).toHaveBeenCalledWith(sql, 'dtk_1');
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const [, eventType, driverId, variables] = mockDispatch.mock.calls[0] as unknown[];
    expect(eventType).toBe(CARD_MONTHLY_LIMIT_EVENT);
    expect(eventType).toBe('token.MonthlyLimitReached');
    expect(driverId).toBe('drv_1');
    expect(variables).toMatchObject({
      idToken: 'CARD-1',
      label: '',
      fleetName: 'Northwind',
      stationId: 'CS-1',
      currency: 'EUR',
    });
    expect((variables as { limitFormatted: { cents: number } }).limitFormatted.cents).toBe(5000);
  });

  it('sends nothing for a card no member holds or a notice already sent', async () => {
    mockClaim.mockResolvedValueOnce(null);
    await sendCardMonthlyLimitNotice({ sql: sqlReturning([]), logger }, 'dtk_1', 'CS-1');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('logs a failure and does not throw', async () => {
    mockClaim.mockRejectedValueOnce(new Error('db down'));
    await expect(
      sendCardMonthlyLimitNotice({ sql: sqlReturning([]), logger }, 'dtk_1', 'CS-1'),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('reads the card of a session and sends nothing for a session without one', async () => {
    await sendSessionCardMonthlyLimitNotice(
      { sql: sqlReturning([{ token_id: null }]), logger },
      'ses_1',
      'CS-1',
    );
    expect(mockClaim).not.toHaveBeenCalled();
    mockClaim.mockResolvedValueOnce(null);
    const sql = sqlReturning([{ token_id: 'dtk_2' }]);
    await sendSessionCardMonthlyLimitNotice({ sql, logger }, 'ses_1', 'CS-1');
    expect(mockClaim).toHaveBeenCalledWith(sql, 'dtk_2');
  });
});
