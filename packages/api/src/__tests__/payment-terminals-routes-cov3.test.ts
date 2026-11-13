// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Payment terminal routes: the feature status, the list views, the provider
// device list, create, read, edit, delete, pairing, status, the payments of a
// terminal, an operator payment, the void and the terminal SIM. Every branch
// answers the documented status and error code and calls the service with the
// caller's values.

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { TerminalProviderError } from '@evtivity/payment-terminals';

const m = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  getUserSiteIds: vi.fn(),
  getTerminal: vi.fn(),
  openTerminalAttachment: vi.fn(),
  requestHasPermission: vi.fn(),
  availableProviders: vi.fn(),
  getProvider: vi.fn(),
  isVoidable: vi.fn(),
  voidTerminalTransaction: vi.fn(),
  attachPaymentTerminalSim: vi.fn(),
  auditPaymentTerminalAction: vi.fn(),
  createPaymentTerminal: vi.fn(),
  deletePaymentTerminal: vi.fn(),
  detachPaymentTerminalSim: vi.fn(),
  pairPaymentTerminal: vi.fn(),
  setPaymentTerminalStatus: vi.fn(),
  unpairPaymentTerminal: vi.fn(),
  updatePaymentTerminal: vi.fn(),
  startTerminalPaymentFlow: vi.fn(),
}));

function chain(): Record<string, unknown> {
  const builder: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'orderBy', 'limit', 'offset']) {
    builder[method] = () => builder;
  }
  builder['then'] = (resolve: (rows: unknown[]) => unknown) =>
    resolve(m.selectResults.shift() ?? []);
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
    getTerminal: m.getTerminal,
    openTerminalAttachment: m.openTerminalAttachment,
  };
});

vi.mock('@evtivity/payments', () => ({
  isVoidable: m.isVoidable,
  voidTerminalTransaction: m.voidTerminalTransaction,
}));
vi.mock('@evtivity/services/payment-terminal.service', () => ({
  attachPaymentTerminalSim: m.attachPaymentTerminalSim,
  auditPaymentTerminalAction: m.auditPaymentTerminalAction,
  createPaymentTerminal: m.createPaymentTerminal,
  deletePaymentTerminal: m.deletePaymentTerminal,
  detachPaymentTerminalSim: m.detachPaymentTerminalSim,
  pairPaymentTerminal: m.pairPaymentTerminal,
  setPaymentTerminalStatus: m.setPaymentTerminalStatus,
  unpairPaymentTerminal: m.unpairPaymentTerminal,
  updatePaymentTerminal: m.updatePaymentTerminal,
}));
vi.mock('@evtivity/services/payment-terminal-flow', () => ({
  startTerminalPaymentFlow: m.startTerminalPaymentFlow,
}));
vi.mock('../lib/payments.js', () => ({
  paymentContext: vi.fn(() => ({ ctx: true })),
  terminalRegistry: { availableProviders: m.availableProviders, getProvider: m.getProvider },
}));
vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: m.getUserSiteIds,
  invalidateSiteAccessCache: vi.fn(),
}));
vi.mock('../middleware/rbac.js', () => ({
  requestHasPermission: m.requestHasPermission,
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (n: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
}));

import { registerAuth } from '../plugins/auth.js';
import { paymentTerminalRoutes } from '../routes/payment-terminals.js';

const NOW = new Date('2026-10-29T10:00:00.000Z');
const TID = 'ptm_000000000001';
const XID = 'ptx_000000000001';
const SITE = 'sit_000000000001';

/** A terminal without a site, station or connector: its view reads the SIM rows only. */
function terminal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TID,
    label: 'Lobby',
    provider: 'simulated',
    integrationMode: 'cloud',
    providerDeviceId: 'sim_term_1',
    vendor: 'ID TECH',
    model: 'VP6825',
    serialNumber: '6825SIM000001',
    firmwareVersion: '1.01.106',
    siteId: null,
    stationId: null,
    evseId: null,
    status: 'active',
    online: true,
    lastSeenAt: NOW,
    statusFetchedAt: null,
    offlineSince: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function txn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: XID,
    paymentTerminalId: TID,
    state: 'authorized',
    currency: 'USD',
    requestedCents: 5000,
    authorizedCents: 5000,
    capturedCents: null,
    refundedCents: 0,
    cardLast4: '4242',
    cardBrand: 'visa',
    declineCode: null,
    failureReason: null,
    siteId: SITE,
    stationId: 'sta_000000000001',
    evseNumber: 1,
    sessionId: null,
    paymentRecordId: null,
    requestedAt: NOW,
    authorizedAt: NOW,
    capturedAt: null,
    voidedAt: null,
    ...overrides,
  };
}

describe('payment terminal routes', () => {
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
    m.selectResults.length = 0;
    m.getUserSiteIds.mockReset().mockResolvedValue(null);
    m.getTerminal.mockReset().mockResolvedValue(terminal());
    m.requestHasPermission.mockReset().mockResolvedValue(true);
    m.getProvider.mockReset().mockResolvedValue({ listDevices: vi.fn() });
  });

  const send = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  describe('GET /payment-terminals/feature', () => {
    it('is available when a provider is configured', async () => {
      m.availableProviders.mockResolvedValue(['simulated']);
      m.selectResults.push([{ count: 0 }]);
      const res = await send('GET', '/payment-terminals/feature');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ available: true, providers: ['simulated'], terminalCount: 0 });
    });

    it('is available when a terminal exists without a provider', async () => {
      m.availableProviders.mockResolvedValue([]);
      m.getUserSiteIds.mockResolvedValue([SITE]);
      m.selectResults.push([{ count: 2 }]);
      const res = await send('GET', '/payment-terminals/feature');
      expect(res.json()).toEqual({ available: true, providers: [], terminalCount: 2 });
    });

    it('is not available with no provider and no terminal (no count row)', async () => {
      m.availableProviders.mockResolvedValue([]);
      m.getUserSiteIds.mockResolvedValue([]);
      m.selectResults.push([]);
      const res = await send('GET', '/payment-terminals/feature');
      expect(res.json()).toEqual({ available: false, providers: [], terminalCount: 0 });
    });
  });

  describe('GET /payment-terminals', () => {
    it('returns the views with site, station, connector and SIM, and the total', async () => {
      m.selectResults.push(
        [
          terminal({
            siteId: SITE,
            stationId: 'sta_000000000001',
            evseId: 'evs_000000000001',
            model: 'VP7200',
            offlineSince: NOW,
          }),
        ],
        [{ count: 7 }],
        [{ id: SITE, name: 'Office Tower' }],
        [{ id: 'sta_000000000001', ocppId: 'CS-1' }],
        [{ id: 'evs_000000000001', evseId: 2 }],
        [{ terminalId: TID }],
      );
      const res = await send('GET', '/payment-terminals?page=1&limit=10');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(7);
      expect(body.data[0]).toMatchObject({
        id: TID,
        siteName: 'Office Tower',
        stationOcppId: 'CS-1',
        evseNumber: 2,
        hasDisplay: false,
        simAttached: true,
        offlineSince: NOW.toISOString(),
        statusFetchedAt: null,
      });
    });

    it('answers an empty page with total 0 when the count row is missing', async () => {
      m.selectResults.push([], []);
      const res = await send('GET', '/payment-terminals');
      expect(res.json()).toEqual({ data: [], total: 0 });
    });

    it('names nothing for an id the lookups do not return', async () => {
      m.selectResults.push(
        [terminal({ siteId: SITE, stationId: 'sta_000000000001', evseId: 'evs_000000000001' })],
        [{ count: 1 }],
        [],
        [],
        [],
        [],
      );
      const res = await send('GET', '/payment-terminals');
      expect(res.json().data[0]).toMatchObject({
        siteName: null,
        stationOcppId: null,
        evseNumber: null,
        simAttached: false,
        hasDisplay: true,
      });
    });
  });

  describe('GET /payment-terminals/provider-devices', () => {
    const url = '/payment-terminals/provider-devices?provider=simulated';

    it('answers 404 to a site-restricted user', async () => {
      m.getUserSiteIds.mockResolvedValue([SITE]);
      const res = await send('GET', url);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PAYMENT_TERMINAL_NOT_FOUND');
      expect(m.getProvider).not.toHaveBeenCalled();
    });

    it('answers 400 when the provider is not configured', async () => {
      m.getProvider.mockResolvedValue(null);
      const res = await send('GET', url);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('PAYMENT_TERMINAL_PROVIDER_NOT_CONFIGURED');
    });

    it('marks the devices already registered', async () => {
      m.getProvider.mockResolvedValue({
        listDevices: vi.fn().mockResolvedValue({
          devices: [
            {
              providerDeviceId: 'sim_term_1',
              vendor: 'ID TECH',
              serialNumber: 'S1',
              model: 'VP6825',
              online: true,
            },
            {
              providerDeviceId: 'sim_term_2',
              vendor: null,
              serialNumber: null,
              model: null,
              online: null,
            },
          ],
        }),
      });
      m.selectResults.push([{ deviceId: 'sim_term_1' }]);
      const res = await send('GET', url);
      expect(res.statusCode).toBe(200);
      expect(res.json().devices).toEqual([
        {
          providerDeviceId: 'sim_term_1',
          vendor: 'ID TECH',
          serialNumber: 'S1',
          model: 'VP6825',
          online: true,
          registered: true,
        },
        {
          providerDeviceId: 'sim_term_2',
          vendor: null,
          serialNumber: null,
          model: null,
          online: null,
          registered: false,
        },
      ]);
    });

    it('answers 502 with the kind for a provider error', async () => {
      m.getProvider.mockResolvedValue({
        listDevices: vi.fn().mockRejectedValue(new TerminalProviderError('device_offline', 'x')),
      });
      const res = await send('GET', url);
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({
        error: 'The payment terminal is offline',
        code: 'PAYMENT_TERMINAL_PROVIDER_ERROR',
        kind: 'device_offline',
      });
    });

    it('uses the generic message for a kind without one', async () => {
      m.getProvider.mockResolvedValue({
        listDevices: vi
          .fn()
          .mockRejectedValue(
            new TerminalProviderError(
              'other' as unknown as ConstructorParameters<typeof TerminalProviderError>[0],
              'x',
            ),
          ),
      });
      const res = await send('GET', url);
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe('The terminal provider request failed');
    });

    it('rethrows any other error (500)', async () => {
      m.getProvider.mockResolvedValue({
        listDevices: vi.fn().mockRejectedValue(new Error('boom')),
      });
      const res = await send('GET', url);
      expect(res.statusCode).toBe(500);
    });
  });

  describe('POST /payment-terminals', () => {
    const base = { provider: 'simulated', providerDeviceId: 'sim_term_3' };

    it('answers 400 when the provider is not configured', async () => {
      m.getProvider.mockResolvedValue(null);
      const res = await send('POST', '/payment-terminals', base);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('PAYMENT_TERMINAL_PROVIDER_NOT_CONFIGURED');
      expect(m.createPaymentTerminal).not.toHaveBeenCalled();
    });

    it('needs stations:write to pair', async () => {
      m.requestHasPermission.mockResolvedValue(false);
      const res = await send('POST', '/payment-terminals', {
        ...base,
        stationId: 'sta_000000000001',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(m.requestHasPermission).toHaveBeenCalledWith(expect.anything(), 'stations:write');
    });

    it('answers 404 for a station outside the caller sites', async () => {
      m.getUserSiteIds.mockResolvedValue([SITE]);
      m.selectResults.push([{ id: 'sta_000000000001', siteId: 'sit_000000000009' }]);
      const res = await send('POST', '/payment-terminals', {
        ...base,
        stationId: 'sta_000000000001',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
    });

    it('answers 404 for a connector of another station', async () => {
      m.selectResults.push([{ id: 'sta_000000000001', siteId: SITE }], []);
      const res = await send('POST', '/payment-terminals', {
        ...base,
        stationId: 'sta_000000000001',
        evseId: 'evs_000000000001',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('EVSE_NOT_FOUND');
    });

    it('creates a paired terminal with the station pairing and no site', async () => {
      m.selectResults.push(
        [{ id: 'sta_000000000001', siteId: SITE }],
        [{ id: 'evs_000000000001' }],
        [],
      );
      m.createPaymentTerminal.mockResolvedValue({ kind: 'created', terminal: terminal() });
      const res = await send('POST', '/payment-terminals', {
        provider: 'idtech',
        providerDeviceId: 'dev-1',
        label: '  ',
        stationId: 'sta_000000000001',
        evseId: 'evs_000000000001',
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().id).toBe(TID);
      expect(m.createPaymentTerminal).toHaveBeenCalledWith(
        {
          provider: 'idtech',
          integrationMode: 'cloud',
          providerDeviceId: 'dev-1',
          label: null,
          vendor: 'ID TECH',
          model: null,
          serialNumber: null,
          firmwareVersion: null,
          siteId: null,
          pairing: { stationId: 'sta_000000000001', evseId: 'evs_000000000001' },
        },
        expect.objectContaining({ actor: expect.objectContaining({ userId: 'usr_000000000001' }) }),
      );
    });

    it('answers 404 for an unknown site', async () => {
      m.selectResults.push([]);
      const res = await send('POST', '/payment-terminals', { ...base, siteId: SITE });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SITE_NOT_FOUND');
    });

    it('answers 404 for a site outside the caller sites', async () => {
      m.getUserSiteIds.mockResolvedValue(['sit_000000000009']);
      m.selectResults.push([{ id: SITE }]);
      const res = await send('POST', '/payment-terminals', { ...base, siteId: SITE });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SITE_NOT_FOUND');
    });

    it('creates an unpaired terminal at a site with the body values', async () => {
      m.selectResults.push([{ id: SITE }], []);
      m.createPaymentTerminal.mockResolvedValue({ kind: 'created', terminal: terminal() });
      const res = await send('POST', '/payment-terminals', {
        ...base,
        siteId: SITE,
        label: ' Gate ',
        vendor: 'V',
        model: 'M',
        serialNumber: 'S',
      });
      expect(res.statusCode).toBe(201);
      expect(m.createPaymentTerminal.mock.calls[0]?.[0]).toMatchObject({
        label: 'Gate',
        vendor: 'V',
        model: 'M',
        serialNumber: 'S',
        siteId: SITE,
        pairing: null,
      });
    });

    it('refuses a site-restricted terminal with neither a station nor a site', async () => {
      m.getUserSiteIds.mockResolvedValue([SITE]);
      const res = await send('POST', '/payment-terminals', base);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('creates a terminal without a site for an all-site user (vendor null)', async () => {
      m.selectResults.push([]);
      m.createPaymentTerminal.mockResolvedValue({ kind: 'created', terminal: terminal() });
      const res = await send('POST', '/payment-terminals', base);
      expect(res.statusCode).toBe(201);
      expect(m.createPaymentTerminal.mock.calls[0]?.[0]).toMatchObject({
        vendor: null,
        siteId: null,
        label: null,
      });
    });

    it.each([
      ['device_taken', 409, 'PAYMENT_TERMINAL_DEVICE_TAKEN'],
      ['evse_taken', 409, 'PAYMENT_TERMINAL_EVSE_TAKEN'],
      ['station_not_found', 404, 'STATION_NOT_FOUND'],
      ['evse_not_found', 404, 'EVSE_NOT_FOUND'],
    ])('maps the service result %s', async (kind, status, code) => {
      m.createPaymentTerminal.mockResolvedValue({ kind });
      const res = await send('POST', '/payment-terminals', base);
      expect(res.statusCode).toBe(status);
      expect(res.json().code).toBe(code);
    });
  });

  describe('GET /payment-terminals/:id', () => {
    it('answers 404 for an unknown terminal', async () => {
      m.getTerminal.mockResolvedValue(null);
      const res = await send('GET', `/payment-terminals/${TID}`);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PAYMENT_TERMINAL_NOT_FOUND');
    });

    it('answers 404 for a terminal of another site', async () => {
      m.getUserSiteIds.mockResolvedValue([SITE]);
      m.getTerminal.mockResolvedValue(terminal({ siteId: 'sit_000000000009' }));
      const res = await send('GET', `/payment-terminals/${TID}`);
      expect(res.statusCode).toBe(404);
    });

    it('returns the view', async () => {
      m.selectResults.push([]);
      const res = await send('GET', `/payment-terminals/${TID}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: TID, label: 'Lobby', simAttached: false });
    });

    it('refuses a malformed id', async () => {
      const res = await send('GET', '/payment-terminals/bad');
      expect(res.statusCode).toBe(400);
    });
  });

  describe('PATCH /payment-terminals/:id', () => {
    it('refuses a site change from a site-restricted user', async () => {
      m.getTerminal.mockResolvedValue(terminal({ siteId: SITE }));
      m.getUserSiteIds.mockResolvedValue([SITE]);
      const res = await send('PATCH', `/payment-terminals/${TID}`, {
        siteId: 'sit_000000000002',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SITE_NOT_FOUND');
      expect(m.updatePaymentTerminal).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown new site', async () => {
      m.selectResults.push([]);
      const res = await send('PATCH', `/payment-terminals/${TID}`, { siteId: SITE });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SITE_NOT_FOUND');
    });

    it('passes only the sent fields, a blank label as null', async () => {
      m.selectResults.push([{ id: SITE }], []);
      m.updatePaymentTerminal.mockResolvedValue({ kind: 'updated', after: terminal() });
      const res = await send('PATCH', `/payment-terminals/${TID}`, {
        label: '   ',
        vendor: null,
        model: 'VP7200',
        serialNumber: 'X',
        siteId: SITE,
      });
      expect(res.statusCode).toBe(200);
      expect(m.updatePaymentTerminal).toHaveBeenCalledWith(
        TID,
        { label: null, vendor: null, model: 'VP7200', serialNumber: 'X', siteId: SITE },
        expect.anything(),
      );
    });

    it('clears the site without a site lookup', async () => {
      m.getTerminal.mockResolvedValue(terminal({ siteId: SITE }));
      m.selectResults.push([]);
      m.updatePaymentTerminal.mockResolvedValue({
        kind: 'updated',
        after: terminal(),
      });
      const res = await send('PATCH', `/payment-terminals/${TID}`, { siteId: null });
      expect(res.statusCode).toBe(200);
      expect(m.updatePaymentTerminal.mock.calls[0]?.[1]).toEqual({ siteId: null });
    });

    it('answers 404 when the service no longer finds it', async () => {
      m.updatePaymentTerminal.mockResolvedValue({ kind: 'not_found' });
      const res = await send('PATCH', `/payment-terminals/${TID}`, { label: 'A' });
      expect(res.statusCode).toBe(404);
      expect(m.updatePaymentTerminal.mock.calls[0]?.[1]).toEqual({ label: 'A' });
    });

    it('answers 400 for a site change of a paired terminal', async () => {
      m.updatePaymentTerminal.mockResolvedValue({ kind: 'paired_site_change' });
      m.selectResults.push([{ id: SITE }]);
      const res = await send('PATCH', `/payment-terminals/${TID}`, { siteId: SITE });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });
  });

  describe('DELETE /payment-terminals/:id', () => {
    it('answers 404 for an invisible terminal and deletes nothing', async () => {
      m.getTerminal.mockResolvedValue(null);
      const res = await send('DELETE', `/payment-terminals/${TID}`);
      expect(res.statusCode).toBe(404);
      expect(m.deletePaymentTerminal).not.toHaveBeenCalled();
    });

    it.each([
      ['not_found', 404, 'PAYMENT_TERMINAL_NOT_FOUND'],
      ['has_transactions', 409, 'PAYMENT_TERMINAL_HAS_TRANSACTIONS'],
    ])('maps %s', async (kind, status, code) => {
      m.deletePaymentTerminal.mockResolvedValue({ kind });
      const res = await send('DELETE', `/payment-terminals/${TID}`);
      expect(res.statusCode).toBe(status);
      expect(res.json().code).toBe(code);
    });

    it('deletes', async () => {
      m.deletePaymentTerminal.mockResolvedValue({ kind: 'deleted' });
      const res = await send('DELETE', `/payment-terminals/${TID}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(m.deletePaymentTerminal).toHaveBeenCalledWith(TID, expect.anything());
    });
  });

  describe('POST /payment-terminals/:id/pair', () => {
    const body = { stationId: 'sta_000000000001', evseId: null };

    it('answers 404 for an unknown station', async () => {
      m.selectResults.push([]);
      const res = await send('POST', `/payment-terminals/${TID}/pair`, body);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
      expect(m.pairPaymentTerminal).not.toHaveBeenCalled();
    });

    it('pairs station-wide', async () => {
      m.selectResults.push([{ id: 'sta_000000000001', siteId: SITE }], []);
      m.pairPaymentTerminal.mockResolvedValue({ kind: 'paired', after: terminal() });
      const res = await send('POST', `/payment-terminals/${TID}/pair`, body);
      expect(res.statusCode).toBe(200);
      expect(m.pairPaymentTerminal).toHaveBeenCalledWith(
        TID,
        { stationId: 'sta_000000000001', evseId: null },
        expect.anything(),
      );
    });

    it.each([
      ['not_found', 404, 'PAYMENT_TERMINAL_NOT_FOUND'],
      ['evse_taken', 409, 'PAYMENT_TERMINAL_EVSE_TAKEN'],
      ['station_not_found', 404, 'STATION_NOT_FOUND'],
      ['evse_not_found', 404, 'EVSE_NOT_FOUND'],
    ])('maps %s', async (kind, status, code) => {
      m.selectResults.push([{ id: 'sta_000000000001', siteId: SITE }]);
      m.pairPaymentTerminal.mockResolvedValue({ kind });
      const res = await send('POST', `/payment-terminals/${TID}/pair`, body);
      expect(res.statusCode).toBe(status);
      expect(res.json().code).toBe(code);
    });

    it('answers 404 for an invisible terminal', async () => {
      m.getTerminal.mockResolvedValue(null);
      const res = await send('POST', `/payment-terminals/${TID}/pair`, body);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PAYMENT_TERMINAL_NOT_FOUND');
    });
  });

  describe('POST /payment-terminals/:id/unpair', () => {
    it.each([
      ['not_found', 404, 'PAYMENT_TERMINAL_NOT_FOUND'],
      ['not_paired', 409, 'PAYMENT_TERMINAL_NOT_PAIRED'],
    ])('maps %s', async (kind, status, code) => {
      m.unpairPaymentTerminal.mockResolvedValue({ kind });
      const res = await send('POST', `/payment-terminals/${TID}/unpair`);
      expect(res.statusCode).toBe(status);
      expect(res.json().code).toBe(code);
    });

    it('unpairs', async () => {
      m.selectResults.push([]);
      m.unpairPaymentTerminal.mockResolvedValue({ kind: 'unpaired', after: terminal() });
      const res = await send('POST', `/payment-terminals/${TID}/unpair`);
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(TID);
    });

    it('answers 404 for an invisible terminal', async () => {
      m.getTerminal.mockResolvedValue(null);
      const res = await send('POST', `/payment-terminals/${TID}/unpair`);
      expect(res.statusCode).toBe(404);
      expect(m.unpairPaymentTerminal).not.toHaveBeenCalled();
    });
  });

  describe('POST /payment-terminals/:id/status', () => {
    it.each([
      ['not_found', 404, 'PAYMENT_TERMINAL_NOT_FOUND'],
      ['evse_taken', 409, 'PAYMENT_TERMINAL_EVSE_TAKEN'],
    ])('maps %s', async (kind, status, code) => {
      m.setPaymentTerminalStatus.mockResolvedValue({ kind });
      const res = await send('POST', `/payment-terminals/${TID}/status`, { status: 'active' });
      expect(res.statusCode).toBe(status);
      expect(res.json().code).toBe(code);
    });

    it('returns the changed terminal', async () => {
      m.selectResults.push([]);
      m.setPaymentTerminalStatus.mockResolvedValue({
        kind: 'changed',
        after: terminal({ status: 'inactive' }),
      });
      const res = await send('POST', `/payment-terminals/${TID}/status`, { status: 'inactive' });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('inactive');
      expect(m.setPaymentTerminalStatus).toHaveBeenCalledWith(TID, 'inactive', expect.anything());
    });

    it('returns the unchanged terminal', async () => {
      m.selectResults.push([]);
      m.setPaymentTerminalStatus.mockResolvedValue({ kind: 'unchanged', terminal: terminal() });
      const res = await send('POST', `/payment-terminals/${TID}/status`, { status: 'active' });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('active');
    });

    it('answers 404 for an invisible terminal', async () => {
      m.getTerminal.mockResolvedValue(null);
      const res = await send('POST', `/payment-terminals/${TID}/status`, { status: 'active' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /payment-terminals/:id/transactions', () => {
    it('lists the payments with their views and total for an all-site user', async () => {
      m.selectResults.push([txn()], [{ count: 1 }]);
      const res = await send('GET', `/payment-terminals/${TID}/transactions`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(1);
      expect(body.data[0]).toMatchObject({
        id: XID,
        state: 'authorized',
        cardLast4: '4242',
        requestedAt: NOW.toISOString(),
        authorizedAt: NOW.toISOString(),
        capturedAt: null,
      });
    });

    it('answers 404 for a user with no sites and a terminal without one', async () => {
      m.getUserSiteIds.mockResolvedValue([]);
      m.getTerminal.mockResolvedValue(terminal({ siteId: null }));
      // siteInScope fails for a restricted user and a terminal without a site.
      const res = await send('GET', `/payment-terminals/${TID}/transactions`);
      expect(res.statusCode).toBe(404);
    });

    it('scopes to the caller sites (count row missing: total 0)', async () => {
      m.getUserSiteIds.mockResolvedValue([SITE]);
      m.getTerminal.mockResolvedValue(terminal({ siteId: SITE }));
      m.selectResults.push([], []);
      const res = await send('GET', `/payment-terminals/${TID}/transactions`);
      expect(res.json()).toEqual({ data: [], total: 0 });
    });
  });

  describe('POST /payment-terminals/:id/payments', () => {
    const url = `/payment-terminals/${TID}/payments`;

    it.each([
      ['not_found', 404, 'PAYMENT_TERMINAL_NOT_FOUND'],
      ['inactive', 409, 'PAYMENT_TERMINAL_INACTIVE'],
      ['not_paired', 409, 'PAYMENT_TERMINAL_NOT_PAIRED'],
      ['busy', 409, 'PAYMENT_TERMINAL_BUSY'],
      ['hardware', 400, 'PAYMENT_TERMINAL_HARDWARE_MODE'],
      ['invalid_amount', 400, 'VALIDATION_ERROR'],
      ['not_configured', 400, 'PAYMENT_TERMINAL_PROVIDER_NOT_CONFIGURED'],
    ])('maps %s without an audit row', async (kind, status, code) => {
      m.startTerminalPaymentFlow.mockResolvedValue({ kind });
      const res = await send('POST', url, {});
      expect(res.statusCode).toBe(status);
      expect(res.json().code).toBe(code);
      expect(m.auditPaymentTerminalAction).not.toHaveBeenCalled();
    });

    it('passes the amount and receipt email, audits and answers started', async () => {
      m.startTerminalPaymentFlow.mockResolvedValue({ kind: 'started', transaction: txn() });
      const res = await send('POST', url, { amountCents: 2500, receiptEmail: 'a@example.com' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ chargingStarted: false, startError: null });
      expect(m.startTerminalPaymentFlow).toHaveBeenCalledWith(
        TID,
        { amountCents: 2500, receiptEmail: 'a@example.com' },
        expect.objectContaining({ portalUrl: expect.any(String) }),
      );
      expect(m.auditPaymentTerminalAction).toHaveBeenCalledWith(
        TID,
        'payment_started',
        expect.objectContaining({ id: XID }),
        expect.anything(),
      );
    });

    it('answers charging started, and leaves the amount out when not sent', async () => {
      m.startTerminalPaymentFlow.mockResolvedValue({
        kind: 'charging_started',
        transaction: txn(),
      });
      const res = await send('POST', url, {});
      expect(res.json()).toMatchObject({ chargingStarted: true, startError: null });
      expect(m.startTerminalPaymentFlow.mock.calls[0]?.[1]).toEqual({ receiptEmail: null });
    });

    it('answers charging not started with the start error', async () => {
      m.startTerminalPaymentFlow.mockResolvedValue({
        kind: 'charging_not_started',
        transaction: txn(),
        code: 'STATION_OFFLINE',
      });
      const res = await send('POST', url, {});
      expect(res.json()).toMatchObject({ chargingStarted: false, startError: 'STATION_OFFLINE' });
      expect(m.auditPaymentTerminalAction).toHaveBeenCalledTimes(1);
    });

    it('audits and answers 502 for a provider error', async () => {
      m.startTerminalPaymentFlow.mockResolvedValue({
        kind: 'provider_error',
        transaction: txn({ state: 'failed' }),
        error: new TerminalProviderError('declined', 'no'),
      });
      const res = await send('POST', url, {});
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ kind: 'declined', error: 'The card was declined' });
      expect(m.auditPaymentTerminalAction).toHaveBeenCalledTimes(1);
    });

    it('refuses an amount outside the hold range', async () => {
      const res = await send('POST', url, { amountCents: 0 });
      expect(res.statusCode).toBe(400);
      expect(m.startTerminalPaymentFlow).not.toHaveBeenCalled();
    });

    it('answers 404 for an invisible terminal', async () => {
      m.getTerminal.mockResolvedValue(null);
      const res = await send('POST', url, {});
      expect(res.statusCode).toBe(404);
      expect(m.startTerminalPaymentFlow).not.toHaveBeenCalled();
    });
  });

  describe('POST /payment-terminal-transactions/:id/void', () => {
    const url = `/payment-terminal-transactions/${XID}/void`;

    it('answers 404 for an unknown payment', async () => {
      m.selectResults.push([]);
      const res = await send('POST', url);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('TERMINAL_TRANSACTION_NOT_FOUND');
    });

    it('answers 404 for a payment of another site', async () => {
      m.getUserSiteIds.mockResolvedValue(['sit_000000000009']);
      m.selectResults.push([txn()]);
      const res = await send('POST', url);
      expect(res.statusCode).toBe(404);
    });

    it('answers 409 for a payment that cannot be voided', async () => {
      m.selectResults.push([txn({ state: 'captured' })]);
      m.isVoidable.mockReturnValue(false);
      const res = await send('POST', url);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('TERMINAL_TRANSACTION_STATE');
      expect(m.voidTerminalTransaction).not.toHaveBeenCalled();
    });

    it('voids, audits the result and returns it', async () => {
      m.selectResults.push([txn()]);
      m.isVoidable.mockReturnValue(true);
      m.voidTerminalTransaction.mockResolvedValue({
        transaction: txn({ state: 'voided', voidedAt: NOW }),
      });
      const res = await send('POST', url);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: 'voided', voidedAt: NOW.toISOString() });
      expect(m.voidTerminalTransaction.mock.calls[0]?.[0]).toBe(XID);
      expect(m.auditPaymentTerminalAction).toHaveBeenCalledWith(
        TID,
        'payment_voided',
        expect.objectContaining({ state: 'voided' }),
        expect.anything(),
      );
    });

    it('returns the read payment when the void returns none', async () => {
      m.selectResults.push([txn()]);
      m.isVoidable.mockReturnValue(true);
      m.voidTerminalTransaction.mockResolvedValue({ transaction: null });
      const res = await send('POST', url);
      expect(res.json().state).toBe('authorized');
    });
  });

  describe('POST and DELETE /payment-terminals/:id/sim', () => {
    const url = `/payment-terminals/${TID}/sim`;
    const iccid = '8901260000000000017';

    it('refuses a value that is no ICCID', async () => {
      const res = await send('POST', url, { iccid: 'abcdefghijklmnopqrs' });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(m.attachPaymentTerminalSim).not.toHaveBeenCalled();
    });

    it.each(['attached', 'unchanged'])('answers success for %s', async (kind) => {
      m.attachPaymentTerminalSim.mockResolvedValue({ kind });
      const res = await send('POST', url, { iccid });
      expect(res.json()).toEqual({ success: true });
      expect(m.attachPaymentTerminalSim).toHaveBeenCalledWith(TID, iccid, true, expect.anything());
    });

    it.each([
      ['sim_attached_elsewhere', 409, 'SIM_ATTACHED_ELSEWHERE'],
      ['sim_inactive', 409, 'SIM_INACTIVE'],
      ['terminal_has_sim', 409, 'PAYMENT_TERMINAL_HAS_SIM'],
      ['sim_not_found', 404, 'PAYMENT_TERMINAL_NOT_FOUND'],
    ])('maps %s', async (kind, status, code) => {
      m.attachPaymentTerminalSim.mockResolvedValue({ kind });
      const res = await send('POST', url, { iccid });
      expect(res.statusCode).toBe(status);
      expect(res.json().code).toBe(code);
    });

    it('attaches unconfirmed for a site-restricted user', async () => {
      m.getUserSiteIds.mockResolvedValue([SITE]);
      m.getTerminal.mockResolvedValue(terminal({ siteId: SITE }));
      m.attachPaymentTerminalSim.mockResolvedValue({ kind: 'attached' });
      await send('POST', url, { iccid });
      expect(m.attachPaymentTerminalSim.mock.calls[0]?.[2]).toBe(false);
    });

    it('answers 404 for an invisible terminal on attach', async () => {
      m.getTerminal.mockResolvedValue(null);
      const res = await send('POST', url, { iccid });
      expect(res.statusCode).toBe(404);
    });

    it('detaches nothing when no SIM is attached', async () => {
      m.openTerminalAttachment.mockResolvedValue(null);
      const res = await send('DELETE', url);
      expect(res.json()).toEqual({ success: true });
      expect(m.detachPaymentTerminalSim).not.toHaveBeenCalled();
    });

    it('detaches the attached SIM', async () => {
      m.openTerminalAttachment.mockResolvedValue({ id: 1 });
      const res = await send('DELETE', url);
      expect(res.json()).toEqual({ success: true });
      expect(m.detachPaymentTerminalSim).toHaveBeenCalledWith(TID, expect.anything());
    });

    it('answers 404 for an invisible terminal on detach', async () => {
      m.getTerminal.mockResolvedValue(null);
      const res = await send('DELETE', url);
      expect(res.statusCode).toBe(404);
      expect(m.openTerminalAttachment).not.toHaveBeenCalled();
    });
  });
});
