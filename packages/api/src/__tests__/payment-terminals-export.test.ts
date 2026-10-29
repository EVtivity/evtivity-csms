// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// GET /v1/payment-terminals/export: the list filters and the caller's site
// scope in the query, the CSV columns, formula-safe values, and no
// credential or card field in the file.

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { selectResults, conditions, authorizeCalls, getUserSiteIdsMock } = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  conditions: [] as Array<{ op: string; args: unknown[] }>,
  authorizeCalls: [] as string[],
  getUserSiteIdsMock: vi.fn(),
}));

/** A select chain that resolves to the next queued result. */
function chain(): Record<string, unknown> {
  const builder: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'orderBy', 'limit', 'offset']) {
    builder[method] = () => builder;
  }
  builder['then'] = (resolve: (rows: unknown[]) => unknown) => resolve(selectResults.shift() ?? []);
  return builder;
}

vi.mock('@evtivity/database', () => {
  const table = (name: string) =>
    new Proxy({}, { get: (_t, column) => `${name}.${String(column)}` });
  return {
    db: { select: () => chain() },
    chargingStations: table('charging_stations'),
    evses: table('evses'),
    paymentTerminals: table('payment_terminals'),
    paymentTerminalTransactions: table('payment_terminal_transactions'),
    simAttachments: table('sim_attachments'),
    sites: table('sites'),
    getTerminal: vi.fn(),
    openTerminalAttachment: vi.fn(),
  };
});

vi.mock('drizzle-orm', () => {
  const record =
    (op: string) =>
    (...args: unknown[]) => {
      conditions.push({ op, args });
      return { op, args };
    };
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values }),
    { raw: (text: string) => ({ sql: text }) },
  );
  return {
    and: record('and'),
    or: record('or'),
    eq: record('eq'),
    ilike: record('ilike'),
    inArray: record('inArray'),
    isNull: record('isNull'),
    desc: (column: unknown) => ({ desc: column }),
    sql,
  };
});

vi.mock('@evtivity/payments', () => ({
  isVoidable: vi.fn(),
  voidTerminalTransaction: vi.fn(),
}));
vi.mock('@evtivity/services/payment-terminal.service', () => ({
  attachPaymentTerminalSim: vi.fn(),
  auditPaymentTerminalAction: vi.fn(),
  createPaymentTerminal: vi.fn(),
  deletePaymentTerminal: vi.fn(),
  detachPaymentTerminalSim: vi.fn(),
  pairPaymentTerminal: vi.fn(),
  setPaymentTerminalStatus: vi.fn(),
  unpairPaymentTerminal: vi.fn(),
  updatePaymentTerminal: vi.fn(),
}));
vi.mock('@evtivity/services/payment-terminal-flow', () => ({
  startTerminalPaymentFlow: vi.fn(),
}));
vi.mock('../lib/payments.js', () => ({
  paymentContext: vi.fn(),
  terminalRegistry: { availableProviders: vi.fn(), getProvider: vi.fn() },
}));
vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: getUserSiteIdsMock,
  invalidateSiteAccessCache: vi.fn(),
}));
vi.mock('../middleware/rbac.js', () => ({
  requestHasPermission: vi.fn(() => true),
  authorize: (permission: string) => {
    authorizeCalls.push(permission);
    return async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (n: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    };
  },
}));

import { registerAuth } from '../plugins/auth.js';
import {
  PAYMENT_TERMINAL_EXPORT_COLUMNS,
  paymentTerminalRoutes,
} from '../routes/payment-terminals.js';

const NOW = new Date('2026-10-29T10:00:00.000Z');

function terminal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ptm_000000000001',
    label: 'Lobby Card Reader',
    provider: 'simulated',
    integrationMode: 'cloud',
    providerDeviceId: 'sim_term_4',
    vendor: 'ID TECH',
    model: 'VP6825',
    serialNumber: '6825SIM000004',
    firmwareVersion: '1.01.106',
    siteId: 'sit_000000000001',
    stationId: 'sta_000000000001',
    evseId: 'evs_000000000001',
    status: 'active',
    online: true,
    lastSeenAt: NOW,
    statusFetchedAt: NOW,
    offlineSince: null,
    offlineAlertedAt: null,
    ocppTerminalId: null,
    createdBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('GET /payment-terminals/export', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    paymentTerminalRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    selectResults.length = 0;
    conditions.length = 0;
    getUserSiteIdsMock.mockReset().mockResolvedValue(['sit_000000000001']);
  });

  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  it('needs paymentTerminals:read, like the list', () => {
    expect(authorizeCalls).toContain('paymentTerminals:read');
  });

  it('writes one row per terminal with the documented columns', async () => {
    selectResults.push(
      [terminal(), terminal({ id: 'ptm_000000000002', evseId: null, online: null, label: null })],
      [{ id: 'sit_000000000001', name: 'Office Tower' }],
      [{ id: 'sta_000000000001', ocppId: 'CS-0981' }],
      [{ id: 'evs_000000000001', evseId: 1 }],
      [{ terminalId: 'ptm_000000000001' }],
    );
    const res = await get('/payment-terminals/export');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toBe('attachment; filename=payment-terminals.csv');
    const lines = res.body.replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toBe(PAYMENT_TERMINAL_EXPORT_COLUMNS.join(','));
    expect(lines[1]).toBe(
      'ptm_000000000001,Lobby Card Reader,simulated,sim_term_4,VP6825,6825SIM000004,cloud,active,true,Office Tower,CS-0981,1,2026-10-29T10:00:00.000Z',
    );
    // Station-wide (no connector), device status unknown, no label.
    expect(lines[2]).toBe(
      'ptm_000000000002,,simulated,sim_term_4,VP6825,6825SIM000004,cloud,active,,Office Tower,CS-0981,,2026-10-29T10:00:00.000Z',
    );
    expect(lines).toHaveLength(3);
  });

  it('applies the search, the filters and the site scope of the caller', async () => {
    selectResults.push([]);
    const res = await get(
      '/payment-terminals/export?search=Lobby&status=active&online=true&siteId=sit_000000000001&stationId=sta_000000000001&page=3&limit=10',
    );
    expect(res.statusCode).toBe(200);
    const eqs = conditions.filter((c) => c.op === 'eq').map((c) => c.args);
    expect(eqs).toEqual(
      expect.arrayContaining([
        ['payment_terminals.siteId', 'sit_000000000001'],
        ['payment_terminals.stationId', 'sta_000000000001'],
        ['payment_terminals.status', 'active'],
        ['payment_terminals.online', true],
      ]),
    );
    expect(conditions).toContainEqual({
      op: 'inArray',
      args: ['payment_terminals.siteId', ['sit_000000000001']],
    });
    expect(conditions.filter((c) => c.op === 'ilike').map((c) => c.args[1])).toEqual([
      '%Lobby%',
      '%Lobby%',
      '%Lobby%',
    ]);
    // Only the header: page and limit are ignored, nothing else is read.
    expect(res.body.replace(/^\uFEFF/, '')).toBe(PAYMENT_TERMINAL_EXPORT_COLUMNS.join(','));
  });

  it('neutralizes a formula in a label and holds no card or credential field', async () => {
    selectResults.push(
      [
        terminal({
          label: '=HYPERLINK("http://x.example")',
          siteId: null,
          stationId: null,
          evseId: null,
        }),
      ],
      [{ terminalId: 'none' }],
    );
    getUserSiteIdsMock.mockResolvedValue(null);
    const res = await get('/payment-terminals/export');
    const lines = res.body.replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://x.example"")"`);
    for (const column of PAYMENT_TERMINAL_EXPORT_COLUMNS) {
      expect(column).not.toMatch(/card|secret|key|token|iccid|password/i);
    }
  });
});
