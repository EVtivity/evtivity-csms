// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';

const { mockInsertFn, mockValuesFn } = vi.hoisted(() => ({
  mockInsertFn: vi.fn(),
  mockValuesFn: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: { insert: mockInsertFn },
  authorizeAttempts: { __table: 'authorize_attempts' },
}));

import {
  logAuthorizeAttempt,
  parseOcpiValidThru,
  setAuthorizeLogPubSub,
  type AuthorizeOutcome,
} from '../../handlers/authorize-log.js';
import type { PubSubClient } from '@evtivity/lib';

const logger = pino({ level: 'silent' });

beforeEach(() => {
  vi.clearAllMocks();
  mockValuesFn.mockResolvedValue(undefined);
  mockInsertFn.mockReturnValue({ values: mockValuesFn });
});

describe('parseOcpiValidThru', () => {
  it('returns null when tokenData is null', () => {
    expect(parseOcpiValidThru(null)).toBeNull();
  });

  it('returns null when tokenData is undefined', () => {
    expect(parseOcpiValidThru(undefined)).toBeNull();
  });

  it('returns null when tokenData is not an object (string)', () => {
    expect(parseOcpiValidThru('not-an-object')).toBeNull();
  });

  it('returns null when tokenData is a number', () => {
    expect(parseOcpiValidThru(42)).toBeNull();
  });

  it('returns null when valid_thru field is missing', () => {
    expect(parseOcpiValidThru({ other: 'field' })).toBeNull();
  });

  it('returns null when valid_thru is not a string', () => {
    expect(parseOcpiValidThru({ valid_thru: 12345 })).toBeNull();
  });

  it('returns null when valid_thru is an empty string', () => {
    expect(parseOcpiValidThru({ valid_thru: '' })).toBeNull();
  });

  it('returns null when valid_thru is whitespace-only', () => {
    expect(parseOcpiValidThru({ valid_thru: '   ' })).toBeNull();
  });

  it('returns null when valid_thru is an unparseable date string', () => {
    expect(parseOcpiValidThru({ valid_thru: 'not-a-date' })).toBeNull();
  });

  it('returns a Date when valid_thru is a valid ISO 8601 datetime', () => {
    const result = parseOcpiValidThru({ valid_thru: '2030-01-01T00:00:00Z' });
    expect(result).toBeInstanceOf(Date);
    expect(result?.toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });
});

describe('logAuthorizeAttempt', () => {
  it('inserts a row with all explicit fields for an accepted outcome', async () => {
    await logAuthorizeAttempt(
      {
        stationId: 'CS-001',
        idToken: 'TAG-ABC',
        tokenType: 'ISO14443',
        matchedTokenId: 'dtk_123',
        matchedDriverId: 'drv_456',
        outcome: 'accepted',
        ocppVersion: 'ocpp1.6',
        reason: 'matched_active_token',
      },
      logger,
    );

    expect(mockInsertFn).toHaveBeenCalledTimes(1);
    expect(mockInsertFn).toHaveBeenCalledWith(
      expect.objectContaining({ __table: 'authorize_attempts' }),
    );
    expect(mockValuesFn).toHaveBeenCalledTimes(1);
    expect(mockValuesFn).toHaveBeenCalledWith({
      stationId: 'CS-001',
      idToken: 'TAG-ABC',
      tokenType: 'ISO14443',
      matchedTokenId: 'dtk_123',
      matchedDriverId: 'drv_456',
      outcome: 'accepted',
      ocppVersion: 'ocpp1.6',
      reason: 'matched_active_token',
    });
  });

  it('defaults matchedTokenId, matchedDriverId, and reason to null when omitted', async () => {
    await logAuthorizeAttempt(
      {
        stationId: 'CS-001',
        idToken: 'TAG-XYZ',
        tokenType: null,
        outcome: 'unknown',
        ocppVersion: 'ocpp1.6',
      },
      logger,
    );

    expect(mockValuesFn).toHaveBeenCalledWith({
      stationId: 'CS-001',
      idToken: 'TAG-XYZ',
      tokenType: null,
      matchedTokenId: null,
      matchedDriverId: null,
      outcome: 'unknown',
      ocppVersion: 'ocpp1.6',
      reason: null,
    });
  });

  it('coerces explicit-null matchedTokenId / matchedDriverId / reason to null', async () => {
    await logAuthorizeAttempt(
      {
        stationId: null,
        idToken: 'TAG-NULLS',
        tokenType: null,
        matchedTokenId: null,
        matchedDriverId: null,
        outcome: 'invalid',
        ocppVersion: 'ocpp2.1',
        reason: null,
      },
      logger,
    );

    expect(mockValuesFn).toHaveBeenCalledWith({
      stationId: null,
      idToken: 'TAG-NULLS',
      tokenType: null,
      matchedTokenId: null,
      matchedDriverId: null,
      outcome: 'invalid',
      ocppVersion: 'ocpp2.1',
      reason: null,
    });
  });

  const outcomes: AuthorizeOutcome[] = [
    'accepted',
    'invalid',
    'blocked',
    'expired',
    'no_credit',
    'concurrent_tx',
    'unknown',
    'db_error',
  ];

  for (const outcome of outcomes) {
    it(`writes the ${outcome} outcome verbatim to the row`, async () => {
      await logAuthorizeAttempt(
        {
          stationId: 'CS-OUT',
          idToken: `TAG-${outcome}`,
          tokenType: 'ISO14443',
          outcome,
          ocppVersion: 'ocpp1.6',
          reason: outcome,
        },
        logger,
      );

      expect(mockValuesFn).toHaveBeenCalledWith(
        expect.objectContaining({ outcome, idToken: `TAG-${outcome}` }),
      );
    });
  }

  it('swallows a DB insert error and logs a warning instead of throwing', async () => {
    const insertError = new Error('connection refused');
    mockValuesFn.mockRejectedValueOnce(insertError);
    const warnSpy = vi.spyOn(logger, 'warn');

    await expect(
      logAuthorizeAttempt(
        {
          stationId: 'CS-ERR',
          idToken: 'TAG-ERR',
          tokenType: 'ISO14443',
          outcome: 'accepted',
          ocppVersion: 'ocpp1.6',
          reason: 'matched',
        },
        logger,
      ),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: insertError, idToken: 'TAG-ERR', outcome: 'accepted' }),
      'Failed to record authorize attempt',
    );
    warnSpy.mockRestore();
  });

  it('swallows a synchronous throw from db.insert and warns', async () => {
    const insertError = new Error('insert blew up');
    mockInsertFn.mockImplementationOnce(() => {
      throw insertError;
    });
    const warnSpy = vi.spyOn(logger, 'warn');

    await expect(
      logAuthorizeAttempt(
        {
          stationId: 'CS-ERR2',
          idToken: 'TAG-ERR2',
          tokenType: null,
          outcome: 'db_error',
          ocppVersion: 'ocpp2.1',
        },
        logger,
      ),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: insertError }),
      'Failed to record authorize attempt',
    );
    warnSpy.mockRestore();
  });
});

describe('logAuthorizeAttempt SSE notification', () => {
  const publish = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    publish.mockClear();
    publish.mockResolvedValue(undefined);
    setAuthorizeLogPubSub({ publish } as unknown as PubSubClient);
  });

  it('publishes an authorize.attempt csms_events after a successful insert', async () => {
    await logAuthorizeAttempt(
      {
        stationId: 'CS-SSE',
        idToken: 'TAG-SSE',
        tokenType: 'ISO14443',
        outcome: 'unknown',
        ocppVersion: 'ocpp2.1',
      },
      logger,
    );

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      'csms_events',
      JSON.stringify({
        eventType: 'authorize.attempt',
        stationId: 'CS-SSE',
        siteId: null,
        sessionId: null,
      }),
    );
  });

  it('does not publish when the insert fails', async () => {
    mockValuesFn.mockRejectedValueOnce(new Error('db down'));

    await logAuthorizeAttempt(
      {
        stationId: 'CS-SSE',
        idToken: 'TAG-SSE',
        tokenType: null,
        outcome: 'db_error',
        ocppVersion: 'ocpp1.6',
      },
      logger,
    );

    expect(publish).not.toHaveBeenCalled();
  });

  it('swallows a publish failure without throwing', async () => {
    publish.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      logAuthorizeAttempt(
        {
          stationId: 'CS-SSE',
          idToken: 'TAG-SSE',
          tokenType: null,
          outcome: 'accepted',
          ocppVersion: 'ocpp1.6',
        },
        logger,
      ),
    ).resolves.toBeUndefined();
  });
});
