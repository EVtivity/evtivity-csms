// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Characterization matrix of the four handlers that decide token
// authorization: 1.6 Authorize (A16), 1.6 StartTransaction (ST16), 2.1
// Authorize (A21) and 2.1 TransactionEvent Started, Updated and Ended (TE21).
// Every handler x token kind x roaming case records the response, the
// authorize attempt it logs, its side effects, the events it publishes, its
// warn and error logs, and one ordered trace of its queries, setting reads and
// publishes, and compares them with the committed snapshot. A refactor of the
// shared authorize pipeline (packages/ocpp/src/authorization/) keeps this
// snapshot unchanged; a behavior change updates it on purpose, row by row.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { Logger } from '@evtivity/lib';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import { handleAuthorize as handleAuthorize16 } from '../../handlers/v1_6/authorize.handler.js';
import { handleStartTransaction } from '../../handlers/v1_6/start-transaction.handler.js';
import { handleAuthorize as handleAuthorize21 } from '../../handlers/v2_1/authorize.handler.js';
import { handleTransactionEvent } from '../../handlers/v2_1/transaction-event.handler.js';
import {
  clearPrepaidAuthorizations,
  rememberPrepaidAuthorization,
} from '../../authorization/prepaid.js';

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
  const state = {
    tables: {} as Record<string, Row[] | Error>,
    /** Every query, setting read and event publish, in order. */
    trace: [] as string[],
    resentRows: [] as Row[],
    stationRows: [] as Row[],
    freeVend: false as boolean | Error,
    roaming: false as boolean | Error,
    /** The driver's account billing fleet with a credit limit (plan S8), or none. */
    accountCredit: null as { fleetId: string; remainingCents: number } | null | Error,
  };
  return {
    TABLE,
    table,
    state,
    logAuthorizeAttempt: vi.fn(),
    remember: vi.fn(),
    validateCert: vi.fn(),
    adHocLimit: vi.fn(),
    prepaidCeiling: vi.fn(),
    accountCeiling: vi.fn(),
    resolveStationTariff: vi.fn(),
  };
});

function matches(row: Row, cond: Cond): boolean {
  if (cond == null) return true;
  if (cond.op === 'and') return cond.conds.every((c) => matches(row, c));
  if (cond.op === 'or') return cond.conds.some((c) => matches(row, c));
  if (cond.op === 'eq') return row[cond.col] === cond.val;
  return row[cond.col] !== cond.val;
}

function runSelect(tableName: string, cond: Cond): Promise<Row[]> {
  h.state.trace.push(tableName);
  const data = h.state.tables[tableName] ?? [];
  if (data instanceof Error) return Promise.reject(data);
  return Promise.resolve(data.filter((r) => matches(r, cond)));
}

function setting(name: string, value: boolean | Error): Promise<boolean> {
  h.state.trace.push(name);
  return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: () => ({
      from: (t: Record<string | symbol, unknown>) => ({
        where: (cond: Cond) => {
          let pending: Promise<Row[]> | null = null;
          const run = (): Promise<Row[]> => (pending ??= runSelect(t[h.TABLE] as string, cond));
          return {
            limit: () => run(),
            then: (
              resolve: (v: Row[]) => unknown,
              reject: (e: unknown) => unknown,
            ): Promise<unknown> => run().then(resolve, reject),
          };
        },
      }),
    }),
    execute: (query: { raw: string }): Promise<Row[]> => {
      if (query.raw.includes('nextval')) {
        h.state.trace.push('execute:nextval');
        return Promise.resolve([{ nextval: '5000' }]);
      }
      if (query.raw.includes('UPDATE charging_sessions')) {
        h.state.trace.push('execute:claim_remote_start');
        return Promise.resolve([]);
      }
      h.state.trace.push('execute:find_resent');
      return Promise.resolve(h.state.resentRows);
    },
    insert: vi.fn(),
  },
  // The tagged-template client: only the A21 station lookup reaches it.
  client: (): Promise<Row[]> => {
    h.state.trace.push('client:station');
    return Promise.resolve(h.state.stationRows);
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
  authorizeAttempts: h.table('authorize_attempts', []),
  isRoamingEnabled: () => setting('roaming', h.state.roaming),
  loadDriverAccountCredit: () => {
    h.state.trace.push('account_credit');
    const credit = h.state.accountCredit;
    return credit instanceof Error ? Promise.reject(credit) : Promise.resolve(credit);
  },
  isSiteFreeVendEnabledByStation: () => setting('freeVend', h.state.freeVend),
  getCompanyCurrency: () => Promise.resolve('USD'),
  getCompanyTaxBasis: () => Promise.resolve('net'),
  resolveStationTariff: h.resolveStationTariff,
}));

vi.mock('drizzle-orm', () => ({
  eq: (a: { col: string }, val: unknown) => ({ op: 'eq', col: a.col, val }),
  ne: (a: { col: string }, val: unknown) => ({ op: 'ne', col: a.col, val }),
  and: (...conds: unknown[]) => ({ op: 'and', conds: conds.filter((c) => c != null) }),
  or: (...conds: unknown[]) => ({ op: 'or', conds: conds.filter((c) => c != null) }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    raw: strings.join('?'),
    values,
  }),
}));

vi.mock('../../authorization/authorize-log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../authorization/authorize-log.js')>()),
  logAuthorizeAttempt: h.logAuthorizeAttempt,
}));

vi.mock('../../authorization/prepaid.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../authorization/prepaid.js')>();
  h.remember.mockImplementation(orig.rememberPrepaidAuthorization);
  return { ...orig, rememberPrepaidAuthorization: h.remember };
});

vi.mock('../../services/pki/contract-certificate-validation.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../services/pki/contract-certificate-validation.js')
  >()),
  validateContractCertificate: h.validateCert,
}));

vi.mock('../../server/session-cost.js', () => ({
  transactionCostAt: () => Promise.resolve(null),
}));

vi.mock('../../server/projection-queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/projection-queue.js')>()),
  projectionQueueFor: () => ({
    settled: () => Promise.resolve(true),
    waitForSignal: () => Promise.resolve(true),
  }),
}));

vi.mock('../../handlers/ad-hoc-payment-limit.js', () => ({
  findAdHocTransactionLimit: h.adHocLimit,
}));

vi.mock('../../handlers/prepaid-session-limit.js', () => ({
  prepaidSessionCeilingCents: (...args: unknown[]) => {
    h.state.trace.push('prepaid_ceiling');
    return h.prepaidCeiling(...args) as Promise<number | null>;
  },
  accountSessionCeilingCents: (...args: unknown[]) => {
    h.state.trace.push('account_ceiling');
    return h.accountCeiling(...args) as Promise<number | null>;
  },
  markAccountCeilingSent: () => Promise.resolve(),
  takeGrownAccountCeiling: () => Promise.resolve(null),
}));

vi.mock('../../handlers/supported-limits.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../handlers/supported-limits.js')>()),
  stationSupportedLimits: () => Promise.resolve(null),
}));

const NOW = new Date('2026-10-07T12:00:00.000Z');
const PAST = new Date('2026-10-01T00:00:00.000Z');
const FUTURE = new Date('2027-01-01T00:00:00.000Z');
const STATION = 'CS-001';

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

function activeSession(
  id: string,
  tokenId: string,
  at: { stationId: string; transactionId: string } = {
    stationId: 'sta_db_2',
    transactionId: 'tx-other',
  },
): Row {
  return { id, tokenId, status: 'active', ...at };
}

interface Kind {
  name: string;
  idToken: string;
  /** The 2.1 IdTokenType; 1.6 sends the idTag only. */
  type: string;
  freeVend?: boolean;
  tables?: Record<string, Row[] | Error>;
  /** ST16: the StartTransaction is a resend of the session with this id. */
  resentSessionId?: string;
  /** A21: the contract certificate verdict, or an Error the validation throws. */
  certificate?: string | Error;
  /** TE21: the stored ad hoc payment limit. */
  adHocLimit?: Record<string, number>;
  /**
   * TE21 Started: the cost ceiling the projection reserved for the prepaid
   * session (default 1500, the whole balance of the prepaid kinds), null when
   * not linked yet, or an Error the lookup throws.
   */
  prepaidCeilingCents?: number | null | Error;
  /**
   * The driver charges on account with a fleet that has a credit limit (plan
   * S8): the credit left (an Error the lookup throws), and for TE21 Started
   * the ceiling the payment gate reserved for the session.
   */
  accountCredit?: { remainingCents: number } | Error;
  accountCeilingCents?: number | null;
  /** A prepaid Authorize remembered this long before NOW. */
  rememberedMsAgo?: number;
  /** The site free vend setting read throws. */
  freeVendError?: boolean;
  /** The roaming setting read throws. */
  roamingError?: boolean;
  /** A21: the request carries iso15118CertificateHashData instead of a PEM chain. */
  certificateHashData?: boolean;
  /** A21: the tariff resolved for the station and driver. */
  tariff?: Row;
  /** The handler context has no station row id (the A21 tariff looks the station up). */
  noStationDbId?: boolean;
}

const GUEST_STATUSES = [
  'pending_payment',
  'payment_authorized',
  'charging',
  'completed',
  'failed',
  'expired',
];

const ACCOUNT_DRIVER_TOKEN = {
  driver_tokens: [token({ id: 'tok-1', idToken: 'TAG-A', tokenType: 'ISO14443' })],
};

const KINDS: Kind[] = [
  {
    name: 'free vend, known token',
    idToken: 'TAG-FV',
    type: 'ISO14443',
    freeVend: true,
    tables: { driver_tokens: [token({ id: 'tok-1', idToken: 'TAG-FV', tokenType: 'ISO14443' })] },
  },
  { name: 'free vend, unknown token', idToken: 'TAG-FV', type: 'ISO14443', freeVend: true },
  {
    name: 'free vend, token lookup error',
    idToken: 'TAG-FV',
    type: 'ISO14443',
    freeVend: true,
    tables: { driver_tokens: new Error('db down') },
  },
  {
    name: 'free vend, inactive token',
    idToken: 'TAG-FV',
    type: 'ISO14443',
    freeVend: true,
    tables: {
      driver_tokens: [
        token({ id: 'tok-1', idToken: 'TAG-FV', tokenType: 'ISO14443', isActive: false }),
      ],
    },
  },
  {
    name: 'active',
    idToken: 'TAG-1',
    type: 'ISO14443',
    tables: { driver_tokens: [token({ id: 'tok-1', idToken: 'TAG-1', tokenType: 'ISO14443' })] },
  },
  {
    name: 'active with expiry',
    idToken: 'TAG-1',
    type: 'ISO14443',
    tables: {
      driver_tokens: [
        token({ id: 'tok-1', idToken: 'TAG-1', tokenType: 'ISO14443', expiresAt: FUTURE }),
      ],
    },
  },
  {
    name: 'active without driver',
    idToken: 'TAG-1',
    type: 'ISO14443',
    tables: {
      driver_tokens: [
        token({ id: 'tok-1', idToken: 'TAG-1', tokenType: 'ISO14443', driverId: null }),
      ],
    },
  },
  {
    name: 'inactive',
    idToken: 'TAG-1',
    type: 'ISO14443',
    tables: {
      driver_tokens: [
        token({ id: 'tok-1', idToken: 'TAG-1', tokenType: 'ISO14443', isActive: false }),
      ],
    },
  },
  {
    name: 'revoked',
    idToken: 'TAG-1',
    type: 'ISO14443',
    tables: {
      driver_tokens: [
        token({ id: 'tok-1', idToken: 'TAG-1', tokenType: 'ISO14443', revokedAt: PAST }),
      ],
    },
  },
  {
    name: 'expired',
    idToken: 'TAG-1',
    type: 'ISO14443',
    tables: {
      driver_tokens: [
        token({ id: 'tok-1', idToken: 'TAG-1', tokenType: 'ISO14443', expiresAt: PAST }),
      ],
    },
  },
  {
    name: 'revoked and expired',
    idToken: 'TAG-1',
    type: 'ISO14443',
    tables: {
      driver_tokens: [
        token({
          id: 'tok-1',
          idToken: 'TAG-1',
          tokenType: 'ISO14443',
          revokedAt: PAST,
          expiresAt: PAST,
        }),
      ],
    },
  },
  {
    name: 'inactive and expired',
    idToken: 'TAG-1',
    type: 'ISO14443',
    tables: {
      driver_tokens: [
        token({
          id: 'tok-1',
          idToken: 'TAG-1',
          tokenType: 'ISO14443',
          isActive: false,
          expiresAt: PAST,
        }),
      ],
    },
  },
  {
    name: 'multiple rows, revoked of this type and active of another',
    idToken: 'TAG-M',
    type: 'ISO14443',
    tables: {
      driver_tokens: [
        token({ id: 'tok-1', idToken: 'TAG-M', tokenType: 'ISO14443', revokedAt: PAST }),
        token({ id: 'tok-2', idToken: 'TAG-M', tokenType: 'eMAID', driverId: 'drv-other' }),
      ],
    },
  },
  {
    name: 'multiple rows, inactive and expired',
    idToken: 'TAG-M',
    type: 'ISO14443',
    tables: {
      driver_tokens: [
        token({ id: 'tok-1', idToken: 'TAG-M', tokenType: 'ISO14443', isActive: false }),
        token({ id: 'tok-2', idToken: 'TAG-M', tokenType: 'eMAID', expiresAt: PAST }),
      ],
    },
  },
  {
    name: 'driver id, active driver',
    idToken: 'drv_abc',
    type: 'Central',
    tables: { drivers: [{ id: 'drv_abc', isActive: true }] },
  },
  {
    name: 'driver id, inactive driver',
    idToken: 'drv_abc',
    type: 'Central',
    tables: { drivers: [{ id: 'drv_abc', isActive: false }] },
  },
  { name: 'driver id, no driver', idToken: 'drv_abc', type: 'Central' },
  ...GUEST_STATUSES.map(
    (status): Kind => ({
      name: `guest session ${status}`,
      idToken: 'gst_tok',
      type: 'Central',
      tables: { guest_sessions: [{ sessionToken: 'gst_tok', status, stationOcppId: STATION }] },
    }),
  ),
  {
    name: 'guest session of another station',
    idToken: 'gst_tok',
    type: 'Central',
    tables: {
      guest_sessions: [
        { sessionToken: 'gst_tok', status: 'payment_authorized', stationOcppId: 'CS-999' },
      ],
    },
  },
  {
    name: 'ocpi valid',
    idToken: 'OCPI-1',
    type: 'ISO14443',
    tables: {
      ocpi_external_tokens: [{ uid: 'OCPI-1', isValid: true, whitelist: 'ALWAYS', tokenData: {} }],
    },
  },
  {
    name: 'ocpi valid_thru in the future',
    idToken: 'OCPI-1',
    type: 'ISO14443',
    tables: {
      ocpi_external_tokens: [
        {
          uid: 'OCPI-1',
          isValid: true,
          whitelist: 'ALLOWED',
          tokenData: { valid_thru: FUTURE.toISOString() },
        },
      ],
    },
  },
  {
    name: 'ocpi whitelist NEVER',
    idToken: 'OCPI-1',
    type: 'ISO14443',
    tables: {
      ocpi_external_tokens: [{ uid: 'OCPI-1', isValid: true, whitelist: 'NEVER', tokenData: {} }],
    },
  },
  {
    name: 'ocpi not valid',
    idToken: 'OCPI-1',
    type: 'ISO14443',
    tables: {
      ocpi_external_tokens: [
        { uid: 'OCPI-1', isValid: false, whitelist: 'ALLOWED', tokenData: {} },
      ],
    },
  },
  {
    name: 'ocpi valid_thru in the past',
    idToken: 'OCPI-1',
    type: 'ISO14443',
    tables: {
      ocpi_external_tokens: [
        {
          uid: 'OCPI-1',
          isValid: true,
          whitelist: 'ALWAYS',
          tokenData: { valid_thru: PAST.toISOString() },
        },
      ],
    },
  },
  {
    name: 'ocpi lookup error',
    idToken: 'OCPI-1',
    type: 'ISO14443',
    tables: { ocpi_external_tokens: new Error('relation does not exist') },
  },
  { name: 'unknown', idToken: 'TAG-X', type: 'ISO14443' },
  { name: 'unknown eMAID', idToken: 'EMAID-X', type: 'eMAID' },
  { name: 'MasterPass', idToken: 'MASTER', type: 'MasterPass' },
  {
    name: 'MasterPass with an inactive row',
    idToken: 'MASTER',
    type: 'MasterPass',
    tables: {
      driver_tokens: [
        token({ id: 'tok-1', idToken: 'MASTER', tokenType: 'MasterPass', isActive: false }),
      ],
    },
  },
  {
    name: 'DirectPayment with ad hoc limit',
    idToken: 'PAY-1',
    type: 'DirectPayment',
    adHocLimit: { maxCost: 25 },
  },
  { name: 'NoAuthorization', idToken: 'NOAUTH', type: 'NoAuthorization' },
  { name: 'Central unknown', idToken: 'CEN-1', type: 'Central' },
  { name: 'Local unknown', idToken: 'LOC-1', type: 'Local' },
  {
    name: 'Central with an inactive row',
    idToken: 'CEN-1',
    type: 'Central',
    tables: {
      driver_tokens: [
        token({ id: 'tok-1', idToken: 'CEN-1', tokenType: 'Central', isActive: false }),
      ],
    },
  },
  {
    name: 'Central unknown with ad hoc limit',
    idToken: 'QR-1',
    type: 'Central',
    adHocLimit: { maxCost: 40 },
  },
  {
    name: 'token lookup error',
    idToken: 'TAG-1',
    type: 'ISO14443',
    tables: { driver_tokens: new Error('db down') },
  },
  {
    name: 'concurrent session',
    idToken: 'TAG-1',
    type: 'ISO14443',
    tables: {
      driver_tokens: [token({ id: 'tok-1', idToken: 'TAG-1', tokenType: 'ISO14443' })],
      charging_sessions: [activeSession('ses-1', 'tok-1')],
    },
  },
  {
    name: 'concurrent session is the resent StartTransaction',
    idToken: 'TAG-1',
    type: 'ISO14443',
    resentSessionId: 'ses-resent',
    tables: {
      driver_tokens: [token({ id: 'tok-1', idToken: 'TAG-1', tokenType: 'ISO14443' })],
      // The resend's transaction (ST16 gets id 77 back) at this station.
      charging_sessions: [
        activeSession('ses-resent', 'tok-1', { stationId: 'sta_db_1', transactionId: '77' }),
      ],
    },
  },
  {
    name: 'concurrent session lookup error',
    idToken: 'TAG-1',
    type: 'ISO14443',
    tables: {
      driver_tokens: [token({ id: 'tok-1', idToken: 'TAG-1', tokenType: 'ISO14443' })],
      charging_sessions: new Error('db down'),
    },
  },
  {
    name: 'prepaid with credit',
    idToken: 'TAG-P',
    type: 'ISO14443',
    tables: {
      driver_tokens: [
        token({ id: 'tok-1', idToken: 'TAG-P', tokenType: 'ISO14443', prepaidBalanceCents: 1500 }),
      ],
    },
  },
  {
    name: 'prepaid with credit, authorized before',
    idToken: 'TAG-P',
    type: 'ISO14443',
    rememberedMsAgo: 60_000,
    tables: {
      driver_tokens: [
        token({ id: 'tok-1', idToken: 'TAG-P', tokenType: 'ISO14443', prepaidBalanceCents: 1500 }),
      ],
    },
  },
  {
    name: 'prepaid without credit',
    idToken: 'TAG-P',
    type: 'ISO14443',
    tables: {
      driver_tokens: [
        token({ id: 'tok-1', idToken: 'TAG-P', tokenType: 'ISO14443', prepaidBalanceCents: 0 }),
      ],
    },
  },
  {
    name: 'prepaid with credit and expiry',
    idToken: 'TAG-P',
    type: 'ISO14443',
    tables: {
      driver_tokens: [
        token({
          id: 'tok-1',
          idToken: 'TAG-P',
          tokenType: 'ISO14443',
          prepaidBalanceCents: 1500,
          expiresAt: FUTURE,
        }),
      ],
    },
  },
  {
    name: 'prepaid with credit in a concurrent session',
    idToken: 'TAG-P',
    type: 'ISO14443',
    tables: {
      driver_tokens: [
        token({ id: 'tok-1', idToken: 'TAG-P', tokenType: 'ISO14443', prepaidBalanceCents: 1500 }),
      ],
      charging_sessions: [activeSession('ses-1', 'tok-1')],
    },
  },
  ...(
    [
      ["reserved in part by the token's other sessions", 600],
      ["reserved in full by the token's other sessions", 0],
      ['session not linked yet', null],
      ['ceiling lookup error', new Error('db down')],
    ] as const
  ).map(
    ([what, ceiling]): Kind => ({
      name: `prepaid with credit, ${what}`,
      idToken: 'TAG-P',
      type: 'ISO14443',
      prepaidCeilingCents: ceiling,
      tables: {
        driver_tokens: [
          token({
            id: 'tok-1',
            idToken: 'TAG-P',
            tokenType: 'ISO14443',
            prepaidBalanceCents: 1500,
          }),
        ],
      },
    }),
  ),
  {
    // TE21 Started: the projection already linked the event's own session
    // (transaction tx-1 at this station) to the token. It is not concurrent.
    name: 'prepaid with credit, own transaction in progress',
    idToken: 'TAG-P',
    type: 'ISO14443',
    tables: {
      driver_tokens: [
        token({ id: 'tok-1', idToken: 'TAG-P', tokenType: 'ISO14443', prepaidBalanceCents: 1500 }),
      ],
      charging_sessions: [
        activeSession('ses-own', 'tok-1', { stationId: 'sta_db_1', transactionId: 'tx-1' }),
      ],
    },
  },
  ...['Accepted', 'CertificateRevoked', 'CertificateExpired', 'CertChainError'].map(
    (verdict): Kind => ({
      name: `C07 ${verdict}`,
      idToken: 'EMAID-1',
      type: 'eMAID',
      certificate: verdict,
      tables: { driver_tokens: [token({ id: 'tok-1', idToken: 'EMAID-1', tokenType: 'eMAID' })] },
    }),
  ),
  {
    name: 'C07 validation throws',
    idToken: 'EMAID-1',
    type: 'eMAID',
    certificate: new Error('OCSP unreachable'),
    tables: { driver_tokens: [token({ id: 'tok-1', idToken: 'EMAID-1', tokenType: 'eMAID' })] },
  },
  {
    name: 'C07 Accepted for an inactive token',
    idToken: 'EMAID-1',
    type: 'eMAID',
    certificate: 'Accepted',
    tables: {
      driver_tokens: [
        token({ id: 'tok-1', idToken: 'EMAID-1', tokenType: 'eMAID', isActive: false }),
      ],
    },
  },
  {
    name: 'C07 CertificateRevoked for a prepaid token',
    idToken: 'EMAID-1',
    type: 'eMAID',
    certificate: 'CertificateRevoked',
    tables: {
      driver_tokens: [
        token({ id: 'tok-1', idToken: 'EMAID-1', tokenType: 'eMAID', prepaidBalanceCents: 1500 }),
      ],
    },
  },
  {
    name: 'C07 Accepted from certificate hash data',
    idToken: 'EMAID-1',
    type: 'eMAID',
    certificate: 'Accepted',
    certificateHashData: true,
    tables: { driver_tokens: [token({ id: 'tok-1', idToken: 'EMAID-1', tokenType: 'eMAID' })] },
  },
  {
    name: 'drivers lookup error',
    idToken: 'drv_abc',
    type: 'Central',
    tables: { drivers: new Error('db down') },
  },
  {
    name: 'guest session lookup error',
    idToken: 'gst_tok',
    type: 'Central',
    tables: { guest_sessions: new Error('db down') },
  },
  { name: 'roaming setting read throws', idToken: 'TAG-X', type: 'ISO14443', roamingError: true },
  {
    name: 'free vend setting read throws',
    idToken: 'TAG-1',
    type: 'ISO14443',
    freeVendError: true,
    tables: { driver_tokens: [token({ id: 'tok-1', idToken: 'TAG-1', tokenType: 'ISO14443' })] },
  },
  {
    name: 'active with a tariff',
    idToken: 'TAG-1',
    type: 'ISO14443',
    tariff: {
      id: 'trf-1',
      pricePerKwh: '0.35',
      pricePerMinute: '0.05',
      pricePerSession: '1.00',
      idleFeePricePerMinute: '0.10',
      taxRate: '0.19',
    },
    tables: { driver_tokens: [token({ id: 'tok-1', idToken: 'TAG-1', tokenType: 'ISO14443' })] },
  },
  {
    name: 'active with a tariff, no station row id',
    idToken: 'TAG-1',
    type: 'ISO14443',
    noStationDbId: true,
    tariff: { id: 'trf-1', pricePerKwh: '0.35', taxRate: '0' },
    tables: { driver_tokens: [token({ id: 'tok-1', idToken: 'TAG-1', tokenType: 'ISO14443' })] },
  },
  {
    name: 'prepaid with credit, no station row id',
    idToken: 'TAG-P',
    type: 'ISO14443',
    noStationDbId: true,
    tables: {
      driver_tokens: [
        token({ id: 'tok-1', idToken: 'TAG-P', tokenType: 'ISO14443', prepaidBalanceCents: 1500 }),
      ],
    },
  },
  // Charge on account with a fleet credit limit (plan S8).
  {
    name: 'account, fleet credit left',
    idToken: 'TAG-A',
    type: 'ISO14443',
    accountCredit: { remainingCents: 1200 },
    accountCeilingCents: 1200,
    tables: ACCOUNT_DRIVER_TOKEN,
  },
  {
    name: 'account, no fleet credit left',
    idToken: 'TAG-A',
    type: 'ISO14443',
    accountCredit: { remainingCents: 0 },
    accountCeilingCents: 0,
    tables: ACCOUNT_DRIVER_TOKEN,
  },
  {
    name: 'account, ceiling not reserved yet',
    idToken: 'TAG-A',
    type: 'ISO14443',
    accountCredit: { remainingCents: 1200 },
    accountCeilingCents: null,
    tables: ACCOUNT_DRIVER_TOKEN,
  },
  {
    name: 'account, fleet credit lookup error',
    idToken: 'TAG-A',
    type: 'ISO14443',
    accountCredit: new Error('db down'),
    tables: ACCOUNT_DRIVER_TOKEN,
  },
];

type HandlerName = 'A16' | 'ST16' | 'A21' | 'TE21 Started' | 'TE21 Updated' | 'TE21 Ended';
const HANDLERS: HandlerName[] = [
  'A16',
  'ST16',
  'A21',
  'TE21 Started',
  'TE21 Updated',
  'TE21 Ended',
];

const handlers: Record<HandlerName, (ctx: HandlerContext) => Promise<Record<string, unknown>>> = {
  A16: handleAuthorize16,
  ST16: handleStartTransaction,
  A21: handleAuthorize21,
  'TE21 Started': handleTransactionEvent,
  'TE21 Updated': handleTransactionEvent,
  'TE21 Ended': handleTransactionEvent,
};

// The levels of the warn and error logs, in order. The wording is not pinned:
// the shared pipeline writes one message per step for every handler.
let logs: string[] = [];
let events: { eventType: string; payload: unknown }[] = [];

function makeLogger(): Logger {
  const record = (level: string) => (): void => {
    if (level === 'warn' || level === 'error') logs.push(level);
  };
  const logger: Record<string, unknown> = {
    info: record('info'),
    debug: record('debug'),
    trace: record('trace'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
  };
  logger['child'] = (): unknown => logger;
  return logger as unknown as Logger;
}

/** The authorize_attempts row logAuthorizeAttempt inserts for these arguments. */
function attemptRow(args: unknown): Record<string, unknown> {
  const a = args as Record<string, unknown>;
  return {
    stationId: a['stationId'],
    idToken: a['idToken'],
    tokenType: a['tokenType'],
    matchedTokenId: a['matchedTokenId'] ?? null,
    matchedDriverId: a['matchedDriverId'] ?? null,
    outcome: a['outcome'],
    ocppVersion: a['ocppVersion'],
    reason: a['reason'] ?? null,
  };
}

const TE21_EVENTS = {
  'TE21 Started': { eventType: 'Started', triggerReason: 'Authorized', seqNo: 0 },
  'TE21 Updated': { eventType: 'Updated', triggerReason: 'Authorized', seqNo: 1 },
  'TE21 Ended': { eventType: 'Ended', triggerReason: 'StopAuthorized', seqNo: 2 },
} as const;

const CERTIFICATE_HASH_DATA = [
  {
    hashAlgorithm: 'SHA256',
    issuerNameHash: 'a',
    issuerKeyHash: 'b',
    serialNumber: 'c',
    responderURL: 'http://ocsp.example',
  },
];

function certificateFields(kind: Kind | null): Record<string, unknown> {
  if (kind?.certificate == null) return {};
  return kind.certificateHashData === true
    ? { iso15118CertificateHashData: CERTIFICATE_HASH_DATA }
    : { certificate: 'PEM-CHAIN' };
}

function payloadFor(handler: HandlerName, kind: Kind | null): Record<string, unknown> {
  const idToken = kind != null ? { idToken: kind.idToken, type: kind.type } : undefined;
  switch (handler) {
    case 'A16':
      return { idTag: kind?.idToken };
    case 'ST16':
      return {
        connectorId: 1,
        idTag: kind?.idToken,
        meterStart: 1000,
        timestamp: '2026-10-07T11:59:00.000Z',
      };
    case 'A21':
      return { idToken, ...certificateFields(kind) };
    case 'TE21 Started':
    case 'TE21 Updated':
    case 'TE21 Ended':
      return {
        ...TE21_EVENTS[handler],
        timestamp: '2026-10-07T11:59:00.000Z',
        transactionInfo: { transactionId: 'tx-1', chargingState: 'Charging' },
        evse: { id: 1, connectorId: 1 },
        ...(idToken != null ? { idToken } : {}),
      };
  }
}

function makeCtx(handler: HandlerName, kind: Kind | null): HandlerContext {
  const protocol = handler === 'A16' || handler === 'ST16' ? 'ocpp1.6' : 'ocpp2.1';
  const action =
    handler === 'ST16'
      ? 'StartTransaction'
      : handler === 'A16' || handler === 'A21'
        ? 'Authorize'
        : 'TransactionEvent';
  const stationDbId = kind?.noStationDbId === true ? null : 'sta_db_1';
  const eventBus = {
    publish: (event: { eventType: string; payload: unknown }): Promise<void> => {
      h.state.trace.push(`publish:${event.eventType}`);
      events.push({ eventType: event.eventType, payload: event.payload });
      return Promise.resolve();
    },
    subscribe: vi.fn(),
    drain: vi.fn(),
    track: vi.fn(),
  };
  return {
    stationId: STATION,
    stationDbId,
    session: {
      stationId: STATION,
      stationDbId,
      connectedAt: NOW,
      lastHeartbeat: NOW,
      authenticated: true,
      pendingMessages: new Map(),
      ocppProtocol: protocol,
      bootStatus: null,
      readyAnnounced: false,
    },
    messageId: 'msg-1',
    action,
    protocolVersion: protocol,
    payload: payloadFor(handler, kind),
    logger: makeLogger(),
    eventBus: eventBus,
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
  };
}

function setUp(kind: Kind | null, roaming: boolean): void {
  h.state.freeVend =
    kind?.freeVendError === true ? new Error('settings down') : kind?.freeVend === true;
  h.state.roaming = kind?.roamingError === true ? new Error('settings down') : roaming;
  h.state.tables = { ...(kind?.tables ?? {}) };
  h.state.trace = [];
  h.state.resentRows =
    kind?.resentSessionId != null
      ? [{ session_id: kind.resentSessionId, transaction_id: '77' }]
      : [];
  h.state.stationRows = [{ id: 'sta_db_1' }];
  logs = [];
  events = [];
  clearPrepaidAuthorizations();
  if (kind?.rememberedMsAgo != null) {
    rememberPrepaidAuthorization(
      STATION,
      kind.idToken,
      new Date(NOW.getTime() - kind.rememberedMsAgo),
    );
  }
  h.remember.mockClear();
  h.logAuthorizeAttempt.mockReset();
  h.logAuthorizeAttempt.mockResolvedValue(undefined);
  h.resolveStationTariff.mockReset();
  h.resolveStationTariff.mockResolvedValue(kind?.tariff ?? null);
  h.adHocLimit.mockReset();
  h.adHocLimit.mockResolvedValue(kind?.adHocLimit ?? null);
  h.state.accountCredit =
    kind?.accountCredit instanceof Error
      ? kind.accountCredit
      : kind?.accountCredit != null
        ? { fleetId: 'flt-1', remainingCents: kind.accountCredit.remainingCents }
        : null;
  h.accountCeiling.mockReset();
  h.accountCeiling.mockResolvedValue(kind?.accountCeilingCents ?? null);
  h.prepaidCeiling.mockReset();
  const ceiling = kind?.prepaidCeilingCents === undefined ? 1500 : kind.prepaidCeilingCents;
  if (ceiling instanceof Error) h.prepaidCeiling.mockRejectedValue(ceiling);
  else h.prepaidCeiling.mockResolvedValue(ceiling);
  h.validateCert.mockReset();
  if (kind?.certificate instanceof Error) h.validateCert.mockRejectedValue(kind.certificate);
  else h.validateCert.mockResolvedValue(kind?.certificate);
}

async function run(handler: HandlerName, kind: Kind | null): Promise<Record<string, unknown>> {
  let response: Record<string, unknown>;
  try {
    response = await handlers[handler](makeCtx(handler, kind));
  } catch (err) {
    // Pinned: a failure the handler does not handle reaches the caller.
    response = { thrown: err instanceof Error ? err.message : String(err) };
  }
  return {
    response,
    authorizeAttempts: h.logAuthorizeAttempt.mock.calls.map(([args]) => attemptRow(args)),
    prepaidRemembered: h.remember.mock.calls.map(([stationId, idToken]) => [stationId, idToken]),
    tariffResolvedFor: h.resolveStationTariff.mock.calls.map(([args]) => args as unknown),
    adHocLimitLookups: h.adHocLimit.mock.calls.length,
    certificateValidations: h.validateCert.mock.calls.length,
    events,
    trace: h.state.trace,
    logs,
  };
}

const cases = HANDLERS.flatMap((handler) =>
  KINDS.flatMap((kind) =>
    [false, true].map((roaming) => ({
      label: `${handler} | ${kind.name} | roaming ${roaming ? 'on' : 'off'}`,
      handler,
      kind,
      roaming,
    })),
  ),
);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

describe('authorize decision matrix', () => {
  it('covers every handler, token kind and roaming setting', () => {
    expect(cases).toHaveLength(HANDLERS.length * KINDS.length * 2);
  });

  // A loop, not it.each: it.each truncates interpolated names, which made
  // snapshot keys ambiguous.
  for (const { label, handler, kind, roaming } of cases) {
    it(label, async () => {
      setUp(kind, roaming);
      expect(await run(handler, kind)).toMatchSnapshot();
    });
  }

  // A TransactionEvent without an idToken skips authorization.
  for (const handler of ['TE21 Started', 'TE21 Updated', 'TE21 Ended'] as const) {
    it(`${handler} | no idToken`, async () => {
      setUp(null, true);
      expect(await run(handler, null)).toMatchSnapshot();
    });
  }
});
