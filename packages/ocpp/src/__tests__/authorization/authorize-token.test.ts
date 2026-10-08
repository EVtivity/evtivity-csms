// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Logger } from '@evtivity/lib';
import type {
  AuthorizeContext,
  AuthorizeContextRules,
  AuthorizeDecision,
  AuthorizeTokenInput,
} from '../../authorization/authorize-context.js';

type Row = Record<string, unknown>;
type Cond =
  | { op: 'eq' | 'ne'; col: string; val: unknown }
  | { op: 'and'; conds: Cond[] }
  | { op: 'or'; conds: Cond[] }
  | undefined;

const h = vi.hoisted(() => {
  const TABLE = Symbol('table');
  function table(name: string, cols: string[]): Record<string | symbol, unknown> {
    const t: Record<string | symbol, unknown> = { [TABLE]: name };
    for (const c of cols) t[c] = { col: c };
    return t;
  }
  const state: {
    TABLE: symbol;
    table: typeof table;
    tables: Record<string, Row[] | Error>;
    queries: { table: string; cond: Cond }[];
    freeVend: boolean | Error;
    roaming: boolean;
    accountCredit: { fleetId: string; remainingCents: number } | null | Error;
    accountCreditCalls: string[];
  } = {
    TABLE,
    table,
    tables: {},
    queries: [],
    freeVend: false,
    roaming: false,
    accountCredit: null,
    accountCreditCalls: [],
  };
  return state;
});

function matches(row: Row, cond: Cond): boolean {
  if (cond == null) return true;
  if (cond.op === 'and') return cond.conds.every((c) => matches(row, c));
  if (cond.op === 'or') return cond.conds.some((c) => matches(row, c));
  if (cond.op === 'eq') return row[cond.col] === cond.val;
  return row[cond.col] !== cond.val;
}

const selectFn = vi.fn(() => ({
  from: (t: Record<string | symbol, unknown>) => ({
    where: (cond: Cond) => {
      let pending: Promise<Row[]> | null = null;
      const run = (): Promise<Row[]> => {
        if (pending == null) {
          const name = t[h.TABLE] as string;
          h.queries.push({ table: name, cond });
          const data = h.tables[name] ?? [];
          pending =
            data instanceof Error
              ? Promise.reject(data)
              : Promise.resolve(data.filter((r) => matches(r, cond)));
        }
        return pending;
      };
      return {
        limit: () => run(),
        then: (resolve: (v: Row[]) => unknown, reject: (e: unknown) => unknown): Promise<unknown> =>
          run().then(resolve, reject),
      };
    },
  }),
}));

vi.mock('@evtivity/database', () => ({
  db: { select: selectFn },
  client: {},
  loadDriverAccountCredit: (_sql: unknown, driverId: string) => {
    h.accountCreditCalls.push(driverId);
    return h.accountCredit instanceof Error
      ? Promise.reject(h.accountCredit)
      : Promise.resolve(h.accountCredit);
  },
  driverTokens: h.table('driver_tokens', [
    'id',
    'driverId',
    'idToken',
    'tokenType',
    'isActive',
    'expiresAt',
    'revokedAt',
    'prepaidBalanceCents',
  ]),
  drivers: h.table('drivers', ['id', 'isActive']),
  guestSessions: h.table('guest_sessions', ['sessionToken', 'status', 'stationOcppId']),
  ocpiExternalTokens: h.table('ocpi_external_tokens', ['uid', 'isValid', 'whitelist', 'tokenData']),
  chargingSessions: h.table('charging_sessions', [
    'id',
    'tokenId',
    'status',
    'stationId',
    'transactionId',
  ]),
  chargingStations: h.table('charging_stations', ['id', 'stationId']),
  isRoamingEnabled: vi.fn(() => Promise.resolve(h.roaming)),
  isSiteFreeVendEnabledByStation: vi.fn(() =>
    h.freeVend instanceof Error ? Promise.reject(h.freeVend) : Promise.resolve(h.freeVend),
  ),
}));

vi.mock('drizzle-orm', () => ({
  eq: (a: { col: string }, val: unknown) => ({ op: 'eq', col: a.col, val }),
  ne: (a: { col: string }, val: unknown) => ({ op: 'ne', col: a.col, val }),
  and: (...conds: unknown[]) => ({ op: 'and', conds: conds.filter((c) => c != null) }),
  or: (...conds: unknown[]) => ({ op: 'or', conds: conds.filter((c) => c != null) }),
}));

const logAuthorizeAttemptMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../authorization/authorize-log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../authorization/authorize-log.js')>()),
  logAuthorizeAttempt: logAuthorizeAttemptMock,
}));

const NOW = new Date('2026-10-07T12:00:00.000Z');
const PAST = new Date('2026-10-01T00:00:00.000Z');
const FUTURE = new Date('2027-01-01T00:00:00.000Z');

let authorizeToken: typeof import('../../authorization/authorize-token.js').authorizeToken;
let recordAuthorizeDecision: typeof import('../../authorization/authorize-token.js').recordAuthorizeDecision;
let authorizeDecisionMessage: typeof import('../../authorization/authorize-token.js').authorizeDecisionMessage;
let logAuthorizeDecision: typeof import('../../authorization/authorize-token.js').logAuthorizeDecision;
let rules: typeof import('../../authorization/authorize-context.js');

beforeAll(async () => {
  rules = await import('../../authorization/authorize-context.js');
  const mod = await import('../../authorization/authorize-token.js');
  authorizeToken = mod.authorizeToken;
  recordAuthorizeDecision = mod.recordAuthorizeDecision;
  authorizeDecisionMessage = mod.authorizeDecisionMessage;
  logAuthorizeDecision = mod.logAuthorizeDecision;
}, 30_000);

const logger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger & Record<'info' | 'debug' | 'warn' | 'error', ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h.freeVend = false;
  h.roaming = false;
  h.tables = {};
  h.queries = [];
  h.accountCredit = null;
  h.accountCreditCalls = [];
});

afterAll(() => {
  vi.useRealTimers();
});

function token(fields: Partial<Row> & { id: string; idToken: string; tokenType: string }): Row {
  return {
    driverId: 'drv-owner',
    isActive: true,
    expiresAt: null,
    revokedAt: null,
    prepaidBalanceCents: null,
    ...fields,
  };
}

function input(
  context: AuthorizeContext,
  value: string,
  type: string | null,
  extra: Partial<AuthorizeTokenInput> = {},
): AuthorizeTokenInput {
  return {
    stationId: 'CS-001',
    stationDbId: 'sta_db_1',
    evseId: 1,
    token: { value, type },
    context,
    ocppVersion: type == null ? 'ocpp1.6' : 'ocpp2.1',
    ...extra,
  };
}

function tables(): string[] {
  return h.queries.map((q) => q.table);
}

const UNTYPED_CONTEXTS: AuthorizeContext[] = ['authorize', 'tx_start', 'tx_update'];
const TX_CONTEXTS: AuthorizeContext[] = ['tx_start', 'tx_update'];

describe('authorizeToken: free vend', () => {
  beforeEach(() => {
    h.freeVend = true;
    h.tables['driver_tokens'] = [token({ id: 'tok-1', idToken: 'TAG', tokenType: 'ISO14443' })];
  });

  it.each([
    ['authorize', null],
    ['authorize', 'ISO14443'],
  ] as const)('%s (%s) accepts with a best-effort token match', async (context, type) => {
    const d = await authorizeToken(input(context, 'TAG', type), logger);
    expect(d).toMatchObject({
      status: 'accepted',
      outcome: 'accepted',
      reason: 'free_vend',
      source: 'free_vend',
      matchedTokenId: 'tok-1',
      matchedDriverId: 'drv-owner',
      echoGroupId: false,
    });
    expect(tables()).toEqual(['driver_tokens']);
  });

  it('matches a typed token by value and type', async () => {
    const d = await authorizeToken(input('authorize', 'TAG', 'eMAID'), logger);
    expect(d.matchedTokenId).toBeNull();
  });

  it.each(UNTYPED_CONTEXTS.filter((c) => c !== 'authorize'))(
    '%s (untyped) accepts without a token match',
    async (context) => {
      const d = await authorizeToken(input(context, 'TAG', null), logger);
      expect(d).toMatchObject({ status: 'accepted', source: 'free_vend', matchedTokenId: null });
      expect(tables()).toEqual([]);
    },
  );

  it.each(TX_CONTEXTS)('%s (typed) accepts with a token match', async (context) => {
    const d = await authorizeToken(input(context, 'TAG', 'ISO14443'), logger);
    expect(d).toMatchObject({ source: 'free_vend', matchedTokenId: 'tok-1' });
  });

  it.each(TX_CONTEXTS)(
    '%s (typed) checks the token when the free vend read fails',
    async (context) => {
      h.freeVend = new Error('settings down');
      const d = await authorizeToken(input(context, 'TAG', 'ISO14443'), logger);
      expect(d).toMatchObject({ source: 'driver_token', status: 'accepted' });
      expect(logger.warn).toHaveBeenCalledTimes(1);
    },
  );

  it('authorize propagates a failed free vend read', async () => {
    h.freeVend = new Error('settings down');
    await expect(authorizeToken(input('authorize', 'TAG', null), logger)).rejects.toThrow(
      'settings down',
    );
  });

  it('accepts without a match and warns when the match lookup fails', async () => {
    h.tables['driver_tokens'] = new Error('db down');
    const d = await authorizeToken(input('authorize', 'TAG', null), logger);
    expect(d).toMatchObject({ status: 'accepted', source: 'free_vend', matchedTokenId: null });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('authorizeToken: token types accepted without lookup', () => {
  it.each([
    ['MasterPass', 'no_lookup_type', true],
    ['DirectPayment', 'no_lookup_type', true],
    ['NoAuthorization', 'no_authorization', false],
  ] as const)('authorize accepts %s', async (type, source, echoGroupId) => {
    const d = await authorizeToken(input('authorize', 'X', type), logger);
    expect(d).toMatchObject({
      status: 'accepted',
      outcome: 'accepted',
      source,
      reason: source,
      echoGroupId,
    });
    expect(tables()).toEqual([]);
  });

  it.each(TX_CONTEXTS)('%s looks MasterPass up', async (context) => {
    h.tables['driver_tokens'] = [
      token({ id: 'tok-1', idToken: 'X', tokenType: 'MasterPass', isActive: false }),
    ];
    const d = await authorizeToken(input(context, 'X', 'MasterPass'), logger);
    expect(d).toMatchObject({ status: 'blocked', reason: 'inactive' });
  });
});

describe('authorizeToken: untyped identity resolution', () => {
  it.each(UNTYPED_CONTEXTS)('%s picks the usable row among several', async (context) => {
    h.tables['driver_tokens'] = [
      token({ id: 'tok-1', idToken: 'TAG', tokenType: 'ISO14443', revokedAt: PAST }),
      token({
        id: 'tok-2',
        idToken: 'TAG',
        tokenType: 'eMAID',
        driverId: 'drv-2',
        expiresAt: FUTURE,
        prepaidBalanceCents: 500,
      }),
    ];
    const d = await authorizeToken(input(context, 'TAG', null), logger);
    expect(d).toEqual<AuthorizeDecision>({
      status: 'accepted',
      outcome: 'accepted',
      reason: 'active',
      source: 'driver_token',
      matchedTokenId: 'tok-2',
      matchedDriverId: 'drv-2',
      expiresAt: FUTURE,
      prepaid: true,
      prepaidBalanceCents: 500,
      echoGroupId: false,
    });
  });

  it('prefers Blocked over Expired when any row is inactive or revoked', async () => {
    h.tables['driver_tokens'] = [
      token({ id: 'tok-2', idToken: 'TAG', tokenType: 'eMAID', expiresAt: PAST }),
      token({ id: 'tok-1', idToken: 'TAG', tokenType: 'ISO14443', isActive: false }),
    ];
    const d = await authorizeToken(input('authorize', 'TAG', null), logger);
    expect(d).toMatchObject({
      status: 'blocked',
      reason: 'inactive',
      matchedTokenId: 'tok-1',
    });
  });

  it('expires when every row is only expired', async () => {
    h.tables['driver_tokens'] = [
      token({ id: 'tok-2', idToken: 'TAG', tokenType: 'eMAID', expiresAt: PAST }),
    ];
    const d = await authorizeToken(input('authorize', 'TAG', null), logger);
    expect(d).toMatchObject({ status: 'expired', reason: 'expired_at', matchedTokenId: 'tok-2' });
  });

  it('blocks a revoked and expired row', async () => {
    h.tables['driver_tokens'] = [
      token({
        id: 'tok-1',
        idToken: 'TAG',
        tokenType: 'ISO14443',
        revokedAt: PAST,
        expiresAt: PAST,
      }),
    ];
    const d = await authorizeToken(input('tx_start', 'TAG', null), logger);
    expect(d).toMatchObject({
      status: 'blocked',
      outcome: 'blocked',
      reason: 'revoked',
    });
  });

  it('blocks the first row when none is usable or expired', async () => {
    h.tables['driver_tokens'] = [
      token({ id: 'tok-1', idToken: 'TAG', tokenType: 'ISO14443', isActive: false }),
      token({ id: 'tok-2', idToken: 'TAG', tokenType: 'eMAID', revokedAt: PAST }),
    ];
    const d = await authorizeToken(input('authorize', 'TAG', null), logger);
    expect(d).toMatchObject({
      status: 'blocked',
      reason: 'inactive',
      matchedTokenId: 'tok-1',
      expiresAt: null,
    });
  });

  it.each([
    ['authorize', 'driver_id'],
    ['tx_start', 'driver_id'],
  ] as const)('%s accepts an active drv_ driver with reason %s', async (context, reason) => {
    h.tables['drivers'] = [{ id: 'drv_abc', isActive: true }];
    const d = await authorizeToken(input(context, 'drv_abc', null), logger);
    expect(d).toMatchObject({
      status: 'accepted',
      source: 'driver_id',
      reason,
      matchedDriverId: 'drv_abc',
      matchedTokenId: null,
    });
    expect(tables()).toEqual(['driver_tokens', 'drivers']);
  });

  it('blocks an inactive drv_ driver', async () => {
    h.tables['drivers'] = [{ id: 'drv_abc', isActive: false }];
    const d = await authorizeToken(input('tx_start', 'drv_abc', null), logger);
    expect(d).toMatchObject({ status: 'blocked', reason: 'driver_inactive', source: 'driver_id' });
  });

  it('falls through to the guest lookup when no drv_ driver exists', async () => {
    const d = await authorizeToken(input('authorize', 'drv_abc', null), logger);
    expect(d.status).toBe('invalid');
    expect(tables()).toEqual(['driver_tokens', 'drivers', 'guest_sessions']);
  });

  it.each([
    ['authorize', 'payment_authorized', 'accepted'],
    ['authorize', 'charging', 'blocked'],
    ['tx_start', 'payment_authorized', 'accepted'],
    ['tx_start', 'charging', 'accepted'],
    ['tx_start', 'pending_payment', 'blocked'],
    ['tx_update', 'charging', 'accepted'],
  ] as const)('%s: guest session %s is %s', async (context, status, expected) => {
    h.tables['guest_sessions'] = [{ sessionToken: 'gst', status, stationOcppId: 'CS-001' }];
    const d = await authorizeToken(input(context, 'gst', null), logger);
    expect(d).toMatchObject({
      status: expected,
      source: 'guest',
      reason: expected === 'accepted' ? 'guest_session' : `guest_${status}`,
    });
  });

  it('ignores a guest session of another station', async () => {
    h.tables['guest_sessions'] = [
      { sessionToken: 'gst', status: 'payment_authorized', stationOcppId: 'CS-999' },
    ];
    const d = await authorizeToken(input('authorize', 'gst', null), logger);
    expect(d).toMatchObject({ status: 'invalid', outcome: 'unknown', reason: 'token_not_found' });
  });
});

describe('authorizeToken: typed identity resolution', () => {
  it.each([
    ['authorize', 'active'],
    ['tx_start', 'active'],
    ['tx_update', 'active'],
  ] as const)('%s accepts an active token with reason %s', async (context, reason) => {
    h.tables['driver_tokens'] = [
      token({ id: 'tok-1', idToken: 'TAG', tokenType: 'ISO14443', expiresAt: FUTURE }),
      token({ id: 'tok-2', idToken: 'TAG', tokenType: 'eMAID', revokedAt: PAST }),
    ];
    const d = await authorizeToken(input(context, 'TAG', 'ISO14443'), logger);
    expect(d).toMatchObject({
      status: 'accepted',
      reason,
      source: 'driver_token',
      matchedTokenId: 'tok-1',
      expiresAt: FUTURE,
      echoGroupId: true,
    });
  });

  it.each([
    ['authorize', { isActive: false }, 'inactive'],
    ['authorize', { revokedAt: PAST, expiresAt: PAST }, 'revoked'],
    ['tx_start', { isActive: false }, 'inactive'],
    ['tx_start', { revokedAt: PAST }, 'revoked'],
    ['tx_update', { revokedAt: PAST, expiresAt: PAST }, 'revoked'],
  ] as const)('%s blocks %o with reason %s', async (context, fields, reason) => {
    h.tables['driver_tokens'] = [
      token({ id: 'tok-1', idToken: 'TAG', tokenType: 'ISO14443', ...fields }),
    ];
    const d = await authorizeToken(input(context, 'TAG', 'ISO14443'), logger);
    expect(d).toMatchObject({
      status: 'blocked',
      outcome: 'blocked',
      reason,
      matchedTokenId: 'tok-1',
      echoGroupId: false,
    });
  });

  it.each([
    ['authorize', 'expired_at'],
    ['tx_start', 'expired_at'],
  ] as const)('%s expires an expired token with reason %s', async (context, reason) => {
    h.tables['driver_tokens'] = [
      token({ id: 'tok-1', idToken: 'TAG', tokenType: 'ISO14443', expiresAt: PAST }),
    ];
    const d = await authorizeToken(input(context, 'TAG', 'ISO14443'), logger);
    expect(d).toMatchObject({
      status: 'expired',
      reason,
      matchedTokenId: 'tok-1',
      expiresAt: null,
    });
  });

  it.each(['Central', 'Local'])('authorize accepts an unknown %s token', async (type) => {
    const d = await authorizeToken(input('authorize', 'X', type), logger);
    expect(d).toMatchObject({
      status: 'accepted',
      outcome: 'accepted',
      reason: 'accept_when_not_found',
      source: 'accept_when_not_found',
      echoGroupId: true,
    });
  });

  it('authorize rejects an unknown ISO14443 token', async () => {
    const d = await authorizeToken(input('authorize', 'X', 'ISO14443'), logger);
    expect(d).toMatchObject({ status: 'invalid', outcome: 'unknown', reason: 'token_not_found' });
  });

  it.each(TX_CONTEXTS)('%s rejects an unknown ISO14443 token (C12.FR.03)', async (context) => {
    const d = await authorizeToken(input(context, 'X', 'ISO14443'), logger);
    expect(d).toMatchObject({
      status: 'invalid',
      outcome: 'unknown',
      reason: 'token_not_found',
      source: 'not_found',
      echoGroupId: false,
    });
  });

  it.each(
    TX_CONTEXTS.flatMap((context) =>
      ['Central', 'Local', 'DirectPayment', 'MasterPass', 'NoAuthorization'].map(
        (type) => [context, type] as const,
      ),
    ),
  )('%s accepts an unknown CSMS-issued %s token', async (context, type) => {
    const d = await authorizeToken(input(context, 'X', type), logger);
    expect(d).toMatchObject({
      status: 'accepted',
      source: 'accept_when_not_found',
      echoGroupId: true,
    });
  });

  it('queries one row by value and type', async () => {
    await authorizeToken(input('authorize', 'X', 'eMAID'), logger);
    expect(h.queries[0]?.cond).toEqual({
      op: 'and',
      conds: [
        { op: 'eq', col: 'idToken', val: 'X' },
        { op: 'eq', col: 'tokenType', val: 'eMAID' },
      ],
    });
  });
});

describe('authorizeToken: OCPI', () => {
  beforeEach(() => {
    h.roaming = true;
  });

  it.each([
    [{ isValid: true, whitelist: 'ALWAYS', tokenData: {} }, 'accepted', 'ocpi_external'],
    [{ isValid: true, whitelist: 'NEVER', tokenData: {} }, 'blocked', 'ocpi_external_never'],
    [{ isValid: false, whitelist: 'ALLOWED', tokenData: {} }, 'blocked', 'ocpi_external_allowed'],
    [
      { isValid: false, whitelist: 'NEVER', tokenData: { valid_thru: PAST.toISOString() } },
      'expired',
      'ocpi_external_valid_thru_expired',
    ],
    [
      { isValid: true, whitelist: 'ALWAYS', tokenData: { valid_thru: FUTURE.toISOString() } },
      'accepted',
      'ocpi_external',
    ],
  ] as const)('%o is %s (%s)', async (row, status, reason) => {
    h.tables['ocpi_external_tokens'] = [{ uid: 'OCPI-1', ...row }];
    for (const type of [null, 'ISO14443']) {
      const d = await authorizeToken(input('authorize', 'OCPI-1', type), logger);
      expect(d).toMatchObject({
        status,
        outcome: status,
        reason,
        source: 'ocpi',
        echoGroupId: false,
      });
    }
  });

  it('skips OCPI when roaming is off', async () => {
    h.roaming = false;
    h.tables['ocpi_external_tokens'] = [{ uid: 'OCPI-1', isValid: true, whitelist: 'ALWAYS' }];
    const d = await authorizeToken(input('authorize', 'OCPI-1', null), logger);
    expect(d.status).toBe('invalid');
  });

  it.each([
    ['tx_start', null],
    ['tx_start', 'ISO14443'],
    ['tx_update', 'ISO14443'],
  ] as const)('%s (%s) checks OCPI tokens', async (context, type) => {
    h.tables['ocpi_external_tokens'] = [{ uid: 'OCPI-1', isValid: true, whitelist: 'ALWAYS' }];
    const d = await authorizeToken(input(context, 'OCPI-1', type), logger);
    expect(d).toMatchObject({ status: 'accepted', reason: 'ocpi_external', source: 'ocpi' });
  });

  it('treats a failed OCPI lookup as not found', async () => {
    h.tables['ocpi_external_tokens'] = new Error('relation does not exist');
    const d = await authorizeToken(input('authorize', 'OCPI-1', 'ISO14443'), logger);
    expect(d).toMatchObject({ status: 'invalid', source: 'not_found' });
    expect(logger.debug).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('authorizeToken: database error', () => {
  it.each([
    ['authorize', null, 'error'],
    ['authorize', 'ISO14443', 'error'],
    ['tx_start', null, 'error'],
    ['tx_start', 'ISO14443', 'warn'],
    ['tx_update', 'ISO14443', 'warn'],
  ] as const)('%s (%s) accepts and logs at %s', async (context, type, level) => {
    h.tables['driver_tokens'] = new Error('db down');
    const d = await authorizeToken(input(context, 'TAG', type), logger);
    expect(d).toEqual<AuthorizeDecision>({
      status: 'accepted',
      outcome: 'db_error',
      reason: 'db_unreachable',
      source: 'db_error',
      matchedTokenId: null,
      matchedDriverId: null,
      expiresAt: null,
      prepaid: false,
      prepaidBalanceCents: null,
      echoGroupId: false,
    });
    expect(logger[level]).toHaveBeenCalledTimes(1);
  });
});

describe('authorizeToken: concurrent transaction', () => {
  beforeEach(() => {
    h.tables['driver_tokens'] = [token({ id: 'tok-1', idToken: 'TAG', tokenType: 'ISO14443' })];
    h.tables['charging_sessions'] = [{ id: 'ses-1', tokenId: 'tok-1', status: 'active' }];
  });

  it.each([
    ['authorize', null],
    ['authorize', 'ISO14443'],
    ['tx_start', null],
  ] as const)('%s (%s) rejects a token in an active session', async (context, type) => {
    const d = await authorizeToken(input(context, 'TAG', type), logger);
    expect(d).toMatchObject({
      status: 'concurrent_tx',
      outcome: 'concurrent_tx',
      reason: 'concurrent_session ses-1',
      matchedTokenId: 'tok-1',
      echoGroupId: false,
    });
  });

  it.each(TX_CONTEXTS)('%s (typed) does not check a postpaid token', async (context) => {
    const d = await authorizeToken(input(context, 'TAG', 'ISO14443'), logger);
    expect(d.status).toBe('accepted');
    expect(tables()).toEqual(['driver_tokens']);
  });

  it('tx_start (typed) rejects a prepaid token in an active session', async () => {
    h.tables['driver_tokens'] = [
      token({ id: 'tok-1', idToken: 'TAG', tokenType: 'ISO14443', prepaidBalanceCents: 1500 }),
    ];
    const d = await authorizeToken(
      input('tx_start', 'TAG', 'ISO14443', { transactionId: 'tx-2' }),
      logger,
    );
    expect(d).toMatchObject({
      status: 'concurrent_tx',
      reason: 'concurrent_session ses-1',
      prepaid: false,
    });
  });

  it('tx_update (typed) does not check a prepaid token', async () => {
    h.tables['driver_tokens'] = [
      token({ id: 'tok-1', idToken: 'TAG', tokenType: 'ISO14443', prepaidBalanceCents: 1500 }),
    ];
    const d = await authorizeToken(input('tx_update', 'TAG', 'ISO14443'), logger);
    expect(d).toMatchObject({ status: 'accepted', prepaid: true });
    expect(tables()).toEqual(['driver_tokens']);
  });

  it.each([
    ['untyped', null],
    ['typed prepaid', 'ISO14443'],
  ] as const)(
    'tx_start (%s) does not count the session of its own transaction',
    async (_kind, type) => {
      h.tables['driver_tokens'] = [
        token({ id: 'tok-1', idToken: 'TAG', tokenType: 'ISO14443', prepaidBalanceCents: 1500 }),
      ];
      h.tables['charging_sessions'] = [
        {
          id: 'ses-own',
          tokenId: 'tok-1',
          status: 'active',
          stationId: 'sta_db_1',
          transactionId: 'tx-1',
        },
      ];
      const d = await authorizeToken(
        input('tx_start', 'TAG', type, { transactionId: 'tx-1' }),
        logger,
      );
      expect(d.status).toBe('accepted');
    },
  );

  it('resolves the station row id to exclude its own transaction when the context has none', async () => {
    h.tables['driver_tokens'] = [
      token({ id: 'tok-1', idToken: 'TAG', tokenType: 'ISO14443', prepaidBalanceCents: 1500 }),
    ];
    h.tables['charging_stations'] = [{ id: 'sta_db_1', stationId: 'CS-001' }];
    h.tables['charging_sessions'] = [
      {
        id: 'ses-own',
        tokenId: 'tok-1',
        status: 'active',
        stationId: 'sta_db_1',
        transactionId: 'tx-1',
      },
    ];
    const d = await authorizeToken(
      input('tx_start', 'TAG', 'ISO14443', { transactionId: 'tx-1', stationDbId: null }),
      logger,
    );
    expect(d.status).toBe('accepted');
    expect(tables()).toContain('charging_stations');
  });

  it('counts every active session when the station row is not found', async () => {
    h.tables['driver_tokens'] = [
      token({ id: 'tok-1', idToken: 'TAG', tokenType: 'ISO14443', prepaidBalanceCents: 1500 }),
    ];
    h.tables['charging_stations'] = [];
    h.tables['charging_sessions'] = [
      {
        id: 'ses-own',
        tokenId: 'tok-1',
        status: 'active',
        stationId: 'sta_db_1',
        transactionId: 'tx-1',
      },
    ];
    const d = await authorizeToken(
      input('tx_start', 'TAG', 'ISO14443', { transactionId: 'tx-1', stationDbId: null }),
      logger,
    );
    expect(d).toMatchObject({ status: 'concurrent_tx', reason: 'concurrent_session ses-own' });
  });

  it('counts a session with the same transaction id at another station', async () => {
    h.tables['charging_sessions'] = [
      {
        id: 'ses-2',
        tokenId: 'tok-1',
        status: 'active',
        stationId: 'sta_db_2',
        transactionId: 'tx-1',
      },
    ];
    const d = await authorizeToken(
      input('tx_start', 'TAG', null, { transactionId: 'tx-1' }),
      logger,
    );
    expect(d).toMatchObject({ status: 'concurrent_tx', reason: 'concurrent_session ses-2' });
  });

  it('keeps the decision and warns when the lookup fails', async () => {
    h.tables['charging_sessions'] = new Error('db down');
    const d = await authorizeToken(input('authorize', 'TAG', null), logger);
    expect(d.status).toBe('accepted');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('wins over prepaid credit', async () => {
    h.tables['driver_tokens'] = [
      token({ id: 'tok-1', idToken: 'TAG', tokenType: 'ISO14443', prepaidBalanceCents: 0 }),
    ];
    const d = await authorizeToken(input('authorize', 'TAG', 'ISO14443'), logger);
    expect(d).toMatchObject({ status: 'concurrent_tx', prepaid: false });
  });
});

describe('authorizeToken: prepaid', () => {
  it.each([
    [1500, 'accepted', true],
    [0, 'no_credit', true],
    [-10, 'no_credit', true],
    [null, 'accepted', false],
  ] as const)('balance %s is %s', async (balance, status, prepaid) => {
    h.tables['driver_tokens'] = [
      token({ id: 'tok-1', idToken: 'TAG', tokenType: 'ISO14443', prepaidBalanceCents: balance }),
    ];
    for (const context of ['authorize', 'tx_start', 'tx_update'] as const) {
      const d = await authorizeToken(input(context, 'TAG', 'ISO14443'), logger);
      expect(d).toMatchObject({ status, prepaid, prepaidBalanceCents: balance });
      if (status === 'no_credit') {
        expect(d).toMatchObject({ outcome: 'no_credit', reason: 'no_credit', echoGroupId: false });
      }
    }
  });

  it('does not mark a rejected token prepaid', async () => {
    h.tables['driver_tokens'] = [
      token({
        id: 'tok-1',
        idToken: 'TAG',
        tokenType: 'ISO14443',
        prepaidBalanceCents: 0,
        isActive: false,
      }),
    ];
    const d = await authorizeToken(input('authorize', 'TAG', null), logger);
    expect(d).toMatchObject({ status: 'blocked', prepaid: false });
  });
});

describe('authorizeToken: fleet credit limit (plan S8)', () => {
  beforeEach(() => {
    h.tables['driver_tokens'] = [
      token({ id: 'tok-1', idToken: 'TAG', tokenType: 'ISO14443', driverId: 'drv-1' }),
    ];
  });

  it.each([
    ['authorize', null],
    ['authorize', 'ISO14443'],
  ] as const)('%s (%s) answers no_credit when the fleet has no credit left', async (ctx, type) => {
    h.accountCredit = { fleetId: 'flt-1', remainingCents: 0 };
    const d = await authorizeToken(input(ctx, 'TAG', type), logger);
    expect(d).toMatchObject({
      status: 'no_credit',
      outcome: 'no_credit',
      reason: 'account_credit_limit',
      echoGroupId: false,
      prepaid: false,
    });
    expect(h.accountCreditCalls).toEqual(['drv-1']);
    expect(authorizeDecisionMessage(d)).toBe('Fleet credit limit reached');
  });

  it('accepts and names the fleet while credit is left', async () => {
    h.accountCredit = { fleetId: 'flt-1', remainingCents: 1200 };
    const d = await authorizeToken(input('authorize', 'TAG', 'ISO14443'), logger);
    expect(d).toMatchObject({ status: 'accepted', accountFleetId: 'flt-1' });
  });

  it('only names the fleet at a 2.1 TransactionEvent Started, even without credit', async () => {
    h.accountCredit = { fleetId: 'flt-1', remainingCents: 0 };
    const d = await authorizeToken(input('tx_start', 'TAG', 'ISO14443'), logger);
    expect(d).toMatchObject({ status: 'accepted', accountFleetId: 'flt-1' });
  });

  it.each([
    ['tx_start', null],
    ['tx_update', null],
    ['tx_update', 'ISO14443'],
  ] as const)('is not checked in %s (%s)', async (ctx, type) => {
    h.accountCredit = { fleetId: 'flt-1', remainingCents: 0 };
    const d = await authorizeToken(input(ctx, 'TAG', type), logger);
    expect(d.status).toBe('accepted');
    expect(d.accountFleetId).toBeUndefined();
    expect(h.accountCreditCalls).toEqual([]);
  });

  it('leaves a card driver (no limited account fleet) unchanged', async () => {
    const d = await authorizeToken(input('authorize', 'TAG', 'ISO14443'), logger);
    expect(d.status).toBe('accepted');
    expect(d.accountFleetId).toBeUndefined();
  });

  it('is not checked for a prepaid token (prepaid comes first)', async () => {
    h.tables['driver_tokens'] = [
      token({
        id: 'tok-1',
        idToken: 'TAG',
        tokenType: 'ISO14443',
        driverId: 'drv-1',
        prepaidBalanceCents: 500,
      }),
    ];
    h.accountCredit = { fleetId: 'flt-1', remainingCents: 0 };
    const d = await authorizeToken(input('authorize', 'TAG', 'ISO14443'), logger);
    expect(d).toMatchObject({ status: 'accepted', prepaid: true });
    expect(h.accountCreditCalls).toEqual([]);
  });

  it('is not checked for a rejected token', async () => {
    h.tables['driver_tokens'] = [
      token({ id: 'tok-1', idToken: 'TAG', tokenType: 'ISO14443', isActive: false }),
    ];
    await authorizeToken(input('authorize', 'TAG', 'ISO14443'), logger);
    expect(h.accountCreditCalls).toEqual([]);
  });

  it('keeps the decision and warns when the lookup fails', async () => {
    h.accountCredit = new Error('db down');
    const d = await authorizeToken(input('authorize', 'TAG', 'ISO14443'), logger);
    expect(d.status).toBe('accepted');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stationId: 'CS-001', idToken: 'TAG' }),
      'Fleet credit limit lookup failed; keeping the decision',
    );
  });
});

describe('recordAuthorizeDecision', () => {
  const accepted = (source: AuthorizeDecision['source']): AuthorizeDecision => ({
    status: 'accepted',
    outcome: 'accepted',
    reason: 'r',
    source,
    matchedTokenId: 'tok-1',
    matchedDriverId: 'drv-1',
    expiresAt: null,
    prepaid: false,
    prepaidBalanceCents: null,
    echoGroupId: false,
  });

  it.each([
    ['authorize', null, 'free_vend', 'ISO14443'],
    ['authorize', null, 'driver_id', 'ISO14443'],
    ['authorize', null, 'guest', 'ISO14443'],
    ['authorize', null, 'driver_token', 'ISO14443'],
    ['authorize', null, 'ocpi', 'ISO14443'],
    ['authorize', null, 'db_error', 'ISO14443'],
    ['tx_start', null, 'free_vend', 'ISO14443'],
    ['tx_start', null, 'guest', 'ISO14443'],
    ['authorize', 'eMAID', 'free_vend', 'eMAID'],
    ['tx_start', 'Central', 'accept_when_not_found', 'Central'],
  ] as const)(
    '%s (%s) logs source %s with token type %s',
    async (context, type, source, logged) => {
      recordAuthorizeDecision(input(context, 'TAG', type), accepted(source), logger);
      expect(logAuthorizeAttemptMock).toHaveBeenCalledWith(
        {
          stationId: 'CS-001',
          idToken: 'TAG',
          tokenType: logged,
          matchedTokenId: 'tok-1',
          matchedDriverId: 'drv-1',
          outcome: 'accepted',
          ocppVersion: type == null ? 'ocpp1.6' : 'ocpp2.1',
          reason: 'r',
        },
        logger,
      );
    },
  );
});

describe('recordAuthorizeDecision failure', () => {
  it('returns before the insert settles and warns when it rejects', async () => {
    let reject: (err: Error) => void = () => undefined;
    logAuthorizeAttemptMock.mockReturnValueOnce(
      new Promise<void>((_resolve, rej) => {
        reject = rej;
      }),
    );
    const decision = await authorizeToken(input('authorize', 'X', 'Central'), logger);
    recordAuthorizeDecision(input('authorize', 'X', 'Central'), decision, logger);
    expect(logger.warn).not.toHaveBeenCalled();
    reject(new Error('insert failed'));
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
  });
});

/** Runs `fn` with one table row changed, then restores it. */
async function withRules(
  context: AuthorizeContext,
  kind: 'untyped' | 'typed',
  change: Partial<AuthorizeContextRules>,
  fn: () => Promise<void>,
): Promise<void> {
  const row = rules.AUTHORIZE_CONTEXT_RULES[context] as {
    untyped: AuthorizeContextRules;
    typed: AuthorizeContextRules;
  };
  const saved = row[kind];
  row[kind] = { ...saved, ...change };
  try {
    await fn();
  } finally {
    row[kind] = saved;
  }
}

describe('reject precedence', () => {
  const revokedAndExpired = (): void => {
    h.tables['driver_tokens'] = [
      token({ id: 'tok-1', idToken: 'TAG', tokenType: 'ISO14443', revokedAt: PAST }),
      token({ id: 'tok-2', idToken: 'TAG', tokenType: 'eMAID', expiresAt: PAST }),
      token({
        id: 'tok-3',
        idToken: 'TAG',
        tokenType: 'Local',
        revokedAt: PAST,
        expiresAt: PAST,
      }),
    ];
  };

  it('is blocked_first for every context and token kind', () => {
    for (const context of ['authorize', 'tx_start', 'tx_update'] as const) {
      expect(rules.AUTHORIZE_CONTEXT_RULES[context].untyped.rejectPrecedence).toBe('blocked_first');
      expect(rules.AUTHORIZE_CONTEXT_RULES[context].typed.rejectPrecedence).toBe('blocked_first');
    }
  });

  it('expired_first expires an untyped idTag with any expired row', async () => {
    revokedAndExpired();
    await withRules('authorize', 'untyped', { rejectPrecedence: 'expired_first' }, async () => {
      const d = await authorizeToken(input('authorize', 'TAG', null), logger);
      expect(d).toMatchObject({ status: 'expired', matchedTokenId: 'tok-2' });
    });
  });

  it('expired_first expires a revoked and expired typed token', async () => {
    revokedAndExpired();
    await withRules('tx_start', 'typed', { rejectPrecedence: 'expired_first' }, async () => {
      const d = await authorizeToken(input('tx_start', 'TAG', 'Local'), logger);
      expect(d).toMatchObject({ status: 'expired', reason: 'expired_at', matchedTokenId: 'tok-3' });
    });
  });

  it('expired_first blocks a typed token that is only revoked', async () => {
    revokedAndExpired();
    await withRules('tx_start', 'typed', { rejectPrecedence: 'expired_first' }, async () => {
      const d = await authorizeToken(input('tx_start', 'TAG', 'ISO14443'), logger);
      expect(d).toMatchObject({ status: 'blocked', reason: 'revoked', matchedTokenId: 'tok-1' });
    });
  });
});

describe('driver id fallback for typed tokens', () => {
  it('is on for every context', () => {
    for (const context of ['authorize', 'tx_start', 'tx_update'] as const) {
      expect(rules.AUTHORIZE_CONTEXT_RULES[context].typed.driverIdFallback).toBe(true);
    }
  });

  it.each(
    (['authorize', 'tx_start', 'tx_update'] as const).flatMap((context) => [
      [context, true, 'accepted', true] as const,
      [context, false, 'blocked', false] as const,
    ]),
  )(
    '%s: a Central drv_ token of a driver with isActive %s is %s',
    async (context, isActive, status, echoGroupId) => {
      h.tables['drivers'] = [{ id: 'drv_abc', isActive }];
      const d = await authorizeToken(input(context, 'drv_abc', 'Central'), logger);
      expect(d).toMatchObject({
        status,
        source: 'driver_id',
        reason: isActive ? 'driver_id' : 'driver_inactive',
        matchedDriverId: 'drv_abc',
        echoGroupId,
      });
    },
  );

  it('an unknown Central driver id falls through to accept-when-not-found', async () => {
    const d = await authorizeToken(input('authorize', 'drv_abc', 'Central'), logger);
    expect(d.source).toBe('accept_when_not_found');
    expect(tables()).toEqual(['driver_tokens', 'drivers']);
  });

  it('does not treat a drv_ value of another type as a driver id', async () => {
    h.tables['drivers'] = [{ id: 'drv_abc', isActive: true }];
    const d = await authorizeToken(input('authorize', 'drv_abc', 'ISO14443'), logger);
    expect(d).toMatchObject({ status: 'invalid', source: 'not_found' });
    expect(tables()).not.toContain('drivers');
  });
});

describe('authorizeDecisionMessage and logAuthorizeDecision', () => {
  const d = (fields: Partial<AuthorizeDecision>): AuthorizeDecision => ({
    status: 'accepted',
    outcome: 'accepted',
    reason: null,
    source: 'driver_token',
    matchedTokenId: null,
    matchedDriverId: null,
    expiresAt: null,
    prepaid: false,
    prepaidBalanceCents: null,
    echoGroupId: false,
    ...fields,
  });

  it.each([
    [{ source: 'free_vend' }, 'Free vend site, accepting'],
    [{ status: 'concurrent_tx' }, 'Token rejected: concurrent transaction'],
    [{ source: 'ocpi', status: 'blocked' }, 'OCPI external token blocked'],
    [{ source: 'not_found', status: 'invalid' }, 'Token not found'],
    [{ source: 'db_error' }, 'Token lookup failed, accepting by default'],
    [{ source: 'driver_id' }, 'Driver-id token accepted'],
    [{ source: 'driver_id', status: 'blocked' }, 'Driver-id token blocked'],
    [{ source: 'guest', status: 'blocked' }, 'Guest session token blocked'],
    [{ status: 'no_credit' }, 'Prepaid token without credit'],
    [{ status: 'expired' }, 'Token rejected by status'],
    [{}, 'Token accepted'],
  ] as const)('%o logs %s', (fields, message) => {
    expect(authorizeDecisionMessage(d(fields))).toBe(message);
  });

  it('logs one info line with the version', () => {
    logAuthorizeDecision(input('authorize', 'TAG', null), d({ source: 'not_found' }), logger);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ idToken: 'TAG', source: 'not_found' }),
      'Token not found (ocpp1.6)',
    );
  });
});

describe('AUTHORIZE_CONTEXT_RULES', () => {
  it('has an untyped and a typed row for every context', () => {
    for (const context of ['authorize', 'tx_start', 'tx_update'] as const) {
      expect(rules.AUTHORIZE_CONTEXT_RULES[context].untyped).toBeDefined();
      expect(rules.AUTHORIZE_CONTEXT_RULES[context].typed).toBeDefined();
    }
  });

  it('picks the row by token type', () => {
    expect(rules.authorizeContextRules(input('authorize', 'X', null))).toBe(
      rules.AUTHORIZE_CONTEXT_RULES.authorize.untyped,
    );
    expect(rules.authorizeContextRules(input('tx_update', 'X', 'Local'))).toBe(
      rules.AUTHORIZE_CONTEXT_RULES.tx_update.typed,
    );
  });
});
