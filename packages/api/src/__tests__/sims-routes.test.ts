// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The SIM inventory routes (`routes/sims.ts`) with their reads, the inventory
// service and the provider part mocked: the feature switch first, the
// site scope passed to every read, the all-site routes, the mapping of
// every service outcome, and no provider call outside Refresh and Network
// Reset. The SQL of the reads and the scope runs in integration 135.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { SimKeyStore } from '@evtivity/services/station-sim.service';

const USER_ID = 'usr_000000000001';
const ROLE_ID = 'rol_000000000001';
const SIM_ID = 'sim_000000000001';
const STATION_ID = 'sta_000000000001';
const SITE_A = 'sit_00000000000a';

/** A mocked read that answers null unless a test sets a value. */
type NullableRead = (...args: unknown[]) => Promise<unknown>;

const m = vi.hoisted(() => ({
  settings: {
    hologram: { enabled: true, apiKey: 'k', orgId: '1' },
    '1nce': { enabled: false, clientId: '', clientSecret: '' },
    stationSignalEnabled: false,
    fetchDays: 7,
    retentionDays: 90,
  },
  enabledProviders: vi.fn(async () => [{ id: 'hologram' }] as unknown[]),
  getProvider: vi.fn<NullableRead>(async () => null),
  listSimViews: vi.fn(async () => ({ data: [] as unknown[], total: 0 })),
  visibleSim: vi.fn<NullableRead>(async () => null),
  simDetailView: vi.fn<NullableRead>(async () => null),
  simViewById: vi.fn<NullableRead>(async () => null),
  simAttachmentHistory: vi.fn(async () => ({ data: [] as unknown[], total: 0 })),
  attachmentViewById: vi.fn<NullableRead>(async () => null),
  stationForAttach: vi.fn<NullableRead>(async () => null),
  simSiteWindows: vi.fn(async () => null),
  simTimelinePage: vi.fn(async () => ({
    items: [] as unknown[],
    nextCursor: null,
    total: 0,
    page: 1,
    previousAt: null,
  })),
  getSimByIccid: vi.fn<NullableRead>(async () => null),
  openSimAttachment: vi.fn<NullableRead>(async () => null),
  ensureSim: vi.fn(),
  updateSim: vi.fn(),
  deleteSim: vi.fn(),
  deactivateSim: vi.fn(),
  reactivateSim: vi.fn(),
  attachSim: vi.fn(),
  detachSimAttachment: vi.fn(),
  confirmStationAttachment: vi.fn(),
  refreshSimProvider: vi.fn(),
  resetSimNetwork: vi.fn(),
  simCoveredDays: vi.fn(async () => [] as unknown[]),
  recordStationCommandAudit: vi.fn(async () => undefined),
  hasPermission: vi.fn(async () => true),
  exportSimsCsv: vi.fn(async () => 'csv'),
  exportSimTemplateCsv: vi.fn(() => 'template'),
  importSimsCsv: vi.fn(async () => ({
    created: 0,
    updated: 0,
    attached: 0,
    errors: [] as string[],
  })),
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
  invalidatePermissionCache: vi.fn(),
  requestHasPermission: m.hasPermission,
}));

vi.mock('../services/sim-import.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  exportSimsCsv: m.exportSimsCsv,
  exportSimTemplateCsv: m.exportSimTemplateCsv,
  importSimsCsv: m.importSimsCsv,
}));

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);

vi.mock('../lib/sim.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readSimSettings: async () => m.settings,
  simProviderRegistry: () => ({
    enabledProviders: m.enabledProviders,
    getProvider: m.getProvider,
  }),
}));

vi.mock('../lib/sim-views.js', () => ({
  listSimViews: m.listSimViews,
  visibleSim: m.visibleSim,
  simDetailView: m.simDetailView,
  simViewById: m.simViewById,
  simAttachmentHistory: m.simAttachmentHistory,
  attachmentViewById: m.attachmentViewById,
  stationForAttach: m.stationForAttach,
  simSiteWindows: m.simSiteWindows,
}));

vi.mock('../lib/sim-timeline.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  simTimelinePage: m.simTimelinePage,
}));

vi.mock('../lib/station-command-audit.js', () => ({
  recordStationCommandAudit: m.recordStationCommandAudit,
}));

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSimByIccid: m.getSimByIccid,
  openSimAttachment: m.openSimAttachment,
  getSystemTimezone: async () => 'UTC',
}));

vi.mock('@evtivity/services/sim-inventory.service', () => ({
  ensureSim: m.ensureSim,
  updateSim: m.updateSim,
  deleteSim: m.deleteSim,
  deactivateSim: m.deactivateSim,
  reactivateSim: m.reactivateSim,
  attachSim: m.attachSim,
  detachSimAttachment: m.detachSimAttachment,
  confirmStationAttachment: m.confirmStationAttachment,
}));

vi.mock('@evtivity/services/station-sim.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshSimProvider: m.refreshSimProvider,
  resetSimNetwork: m.resetSimNetwork,
  simCoveredDays: m.simCoveredDays,
  simHistoryDays: async () => 30,
}));

import { registerAuth } from '../plugins/auth.js';
import { simRoutes, SIM_PAGE_REFRESH_LIMIT_PER_MINUTE } from '../routes/sims.js';
import { setSimKeyStoreForTests } from '../lib/sim-keys.js';
import {
  resetSiteAccessMock,
  setMockStationSites,
  setMockUserSiteIds,
} from './helpers/site-access-mock.js';

/** An in-memory key store: counts and TTLs, no expiry. */
function memoryKeyStore(): SimKeyStore & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    acquire: async () => true,
    renew: async () => true,
    release: async () => undefined,
    ttlSeconds: async () => 42,
    setFor: async () => undefined,
    increment: async (key: string) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
  };
}

const NOW = '2026-10-22T10:00:00.000Z';

function simView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SIM_ID,
    iccid: '8900000000000000001',
    imsi: null,
    label: null,
    notes: null,
    provider: null,
    providerRef: null,
    status: 'active',
    deactivatedAt: null,
    deactivatedBy: null,
    lastStatus: null,
    statusFetchedAt: null,
    lastFetchedAt: null,
    lookupMissedAt: null,
    lookupMissReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    attachment: null,
    ...overrides,
  };
}

function detailView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...simView(),
    deactivatedByUser: null,
    attachedBy: null,
    siteTimezone: null,
    network: null,
    recentAlerts: [],
    ...overrides,
  };
}

function simRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: SIM_ID, iccid: '8900000000000000001', status: 'active', ...overrides };
}

function attachmentItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    stationId: STATION_ID,
    stationOcppId: 'CS-1',
    siteId: SITE_A,
    siteName: 'Site A',
    paymentTerminalId: null,
    source: 'attached',
    attachedAt: NOW,
    attachedBy: null,
    confirmedAt: NOW,
    confirmedBy: USER_ID,
    detachedAt: null,
    detachedBy: null,
    detachReason: null,
    ...overrides,
  };
}

describe('SIM inventory routes', () => {
  let app: FastifyInstance;
  let token: string;
  let keys: ReturnType<typeof memoryKeyStore>;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(simRoutes);
    await app.ready();
    token = app.jwt.sign({ userId: USER_ID, roleId: ROLE_ID });
  });

  afterAll(async () => {
    setSimKeyStoreForTests(null);
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetSiteAccessMock();
    keys = memoryKeyStore();
    setSimKeyStoreForTests(keys);
    m.settings = {
      hologram: { enabled: true, apiKey: 'k', orgId: '1' },
      '1nce': { enabled: false, clientId: '', clientSecret: '' },
      stationSignalEnabled: false,
      fetchDays: 7,
      retentionDays: 90,
    };
    m.enabledProviders.mockResolvedValue([{ id: 'hologram' }]);
    m.getProvider.mockResolvedValue(null);
    m.hasPermission.mockResolvedValue(true);
  });

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  const ROUTES: Array<['GET' | 'POST' | 'PATCH' | 'DELETE', string, unknown]> = [
    ['GET', '/sims', undefined],
    ['POST', '/sims', { iccid: '8900000000000000001' }],
    ['GET', '/sims/export', undefined],
    ['GET', '/sims/export/template', undefined],
    ['POST', '/sims/import', { rows: [], updateExisting: false }],
    ['GET', `/sims/${SIM_ID}`, undefined],
    ['PATCH', `/sims/${SIM_ID}`, { label: 'x' }],
    ['DELETE', `/sims/${SIM_ID}`, undefined],
    ['POST', `/sims/${SIM_ID}/deactivate`, undefined],
    ['POST', `/sims/${SIM_ID}/reactivate`, undefined],
    ['GET', `/sims/${SIM_ID}/attachments`, undefined],
    ['POST', `/sims/${SIM_ID}/attachments`, { stationId: STATION_ID }],
    ['POST', `/sims/${SIM_ID}/attachments/7/detach`, undefined],
    ['POST', `/sims/${SIM_ID}/attachments/7/confirm`, undefined],
    ['GET', `/sims/${SIM_ID}/timeline`, undefined],
    ['POST', `/sims/${SIM_ID}/refresh`, {}],
    ['POST', `/sims/${SIM_ID}/network-reset`, undefined],
  ];

  describe('the feature switches gate every route', () => {
    it('answers 400 SIM_FEATURE_DISABLED on every route while both switches are off, before any read', async () => {
      m.settings = {
        ...m.settings,
        hologram: { enabled: false, apiKey: '', orgId: '' },
        '1nce': { enabled: false, clientId: '', clientSecret: '' },
        stationSignalEnabled: false,
      };
      for (const [method, url, payload] of ROUTES) {
        const res = await call(method, url, payload);
        expect(res.statusCode, `${method} ${url}`).toBe(400);
        expect(res.json<{ code: string }>().code, `${method} ${url}`).toBe('SIM_FEATURE_DISABLED');
      }
      for (const read of [
        m.listSimViews,
        m.visibleSim,
        m.simDetailView,
        m.simViewById,
        m.simAttachmentHistory,
        m.getSimByIccid,
        m.openSimAttachment,
        m.ensureSim,
        m.refreshSimProvider,
        m.resetSimNetwork,
        m.exportSimsCsv,
        m.importSimsCsv,
      ]) {
        expect(read).not.toHaveBeenCalled();
      }
    });

    it('serves the routes with only the station signal reads on', async () => {
      m.settings = {
        ...m.settings,
        hologram: { enabled: false, apiKey: '', orgId: '' },
        '1nce': { enabled: false, clientId: '', clientSecret: '' },
        stationSignalEnabled: true,
      };
      const res = await call('GET', '/sims');
      expect(res.statusCode).toBe(200);
    });
  });

  describe('the site scope reaches every read', () => {
    it('lists with the user sites and the filters', async () => {
      setMockUserSiteIds([SITE_A]);
      m.listSimViews.mockResolvedValueOnce({ data: [simView()], total: 1 });
      const res = await call(
        'GET',
        '/sims?search=8900&attachment=unconfirmed&status=inactive&state=suspended&provider=hologram&page=2&limit=5',
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ total: 1, data: [{ id: SIM_ID }] });
      expect(m.listSimViews).toHaveBeenCalledWith(
        {
          search: '8900',
          provider: 'hologram',
          attachment: 'unconfirmed',
          status: 'inactive',
          state: 'suspended',
        },
        { userId: expect.any(String) as string, siteIds: [SITE_A] },
        2,
        5,
      );
    });

    it('lists every SIM for an all-site user (no scope)', async () => {
      await call('GET', '/sims');
      expect(m.listSimViews).toHaveBeenCalledWith(
        {},
        { userId: expect.any(String) as string, siteIds: null },
        1,
        10,
      );
    });

    it('answers 404 SIM_NOT_FOUND for a SIM out of the scope (unattached, unconfirmed or unsited)', async () => {
      setMockUserSiteIds([SITE_A]);
      for (const [method, url, payload] of [
        ['GET', `/sims/${SIM_ID}`, undefined],
        ['PATCH', `/sims/${SIM_ID}`, { label: 'x' }],
        ['GET', `/sims/${SIM_ID}/attachments`, undefined],
        ['GET', `/sims/${SIM_ID}/timeline`, undefined],
        ['POST', `/sims/${SIM_ID}/refresh`, {}],
        ['POST', `/sims/${SIM_ID}/network-reset`, undefined],
        ['POST', `/sims/${SIM_ID}/attachments/7/detach`, undefined],
      ] as const) {
        const res = await call(method, url, payload);
        expect(res.statusCode, `${method} ${url}`).toBe(404);
        expect(res.json<{ code: string }>().code).toBe('SIM_NOT_FOUND');
      }
      for (const args of m.visibleSim.mock.calls) expect(args[1]).toEqual([SITE_A]);
      for (const args of m.simDetailView.mock.calls) {
        expect(args[1]).toMatchObject({ siteIds: [SITE_A] });
      }
      expect(m.updateSim).not.toHaveBeenCalled();
      expect(m.refreshSimProvider).not.toHaveBeenCalled();
      expect(m.resetSimNetwork).not.toHaveBeenCalled();
      expect(m.detachSimAttachment).not.toHaveBeenCalled();
    });

    it('answers 404 SIM_NOT_FOUND to a site-restricted user on every all-site route', async () => {
      setMockUserSiteIds([SITE_A]);
      for (const [method, url, payload] of [
        ['POST', '/sims', { iccid: '8900000000000000001' }],
        ['DELETE', `/sims/${SIM_ID}`, undefined],
        ['POST', `/sims/${SIM_ID}/deactivate`, undefined],
        ['POST', `/sims/${SIM_ID}/reactivate`, undefined],
        ['POST', `/sims/${SIM_ID}/attachments`, { stationId: STATION_ID }],
        ['POST', `/sims/${SIM_ID}/attachments/7/confirm`, undefined],
      ] as const) {
        const res = await call(method, url, payload);
        expect(res.statusCode, `${method} ${url}`).toBe(404);
        expect(res.json<{ code: string }>().code).toBe('SIM_NOT_FOUND');
      }
      for (const write of [
        m.ensureSim,
        m.deleteSim,
        m.deactivateSim,
        m.reactivateSim,
        m.attachSim,
        m.confirmStationAttachment,
      ]) {
        expect(write).not.toHaveBeenCalled();
      }
    });

    it('lets a site-restricted user detach a SIM from a station of their sites', async () => {
      setMockUserSiteIds([SITE_A]);
      setMockStationSites({ [STATION_ID]: SITE_A });
      m.visibleSim.mockResolvedValueOnce(simRow());
      m.openSimAttachment.mockResolvedValueOnce({ id: 7, stationId: STATION_ID });
      m.detachSimAttachment.mockResolvedValueOnce({ id: 7 });
      m.attachmentViewById.mockResolvedValueOnce(attachmentItem({ detachedAt: NOW }));
      const res = await call('POST', `/sims/${SIM_ID}/attachments/7/detach`);
      expect(res.statusCode).toBe(200);
      expect(m.detachSimAttachment).toHaveBeenCalledWith(SIM_ID, 7, expect.anything());
    });

    it("refuses a site-restricted user's detach of an attachment to a station out of their sites", async () => {
      setMockUserSiteIds([SITE_A]);
      setMockStationSites({ [STATION_ID]: 'sit_00000000000b' });
      m.visibleSim.mockResolvedValueOnce(simRow());
      m.openSimAttachment.mockResolvedValueOnce({ id: 7, stationId: STATION_ID });
      const res = await call('POST', `/sims/${SIM_ID}/attachments/7/detach`);
      expect(res.statusCode).toBe(404);
      expect(m.detachSimAttachment).not.toHaveBeenCalled();
    });
  });

  describe('reads never call a provider', () => {
    it('GET routes read the database only', async () => {
      m.simDetailView.mockResolvedValue(detailView());
      m.visibleSim.mockResolvedValue(simRow());
      for (const url of [
        '/sims',
        `/sims/${SIM_ID}`,
        `/sims/${SIM_ID}/attachments`,
        `/sims/${SIM_ID}/timeline`,
      ]) {
        const res = await call('GET', url);
        expect(res.statusCode, url).toBe(200);
      }
      expect(m.refreshSimProvider).not.toHaveBeenCalled();
      expect(m.resetSimNetwork).not.toHaveBeenCalled();
      m.simDetailView.mockReset();
      m.visibleSim.mockReset();
    });
  });

  describe('GET /sims/:id', () => {
    it('adds the provider data and the coverage time zone', async () => {
      m.simDetailView.mockResolvedValueOnce(
        detailView({ provider: 'hologram', siteTimezone: 'Europe/Berlin' }),
      );
      m.getProvider.mockResolvedValueOnce({
        id: 'hologram',
        capabilities: {
          networkName: true,
          radioAccessTechnology: true,
          cellId: true,
          usage: true,
          sessions: true,
          alerts: true,
          networkReset: true,
        },
        historyDays: 14,
        reportingDelayHours: 2,
      });
      const res = await call('GET', `/sims/${SIM_ID}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: SIM_ID,
        status: 'active',
        historyDays: 14,
        reportingDelayHours: 2,
        fetchDays: 7,
        retentionDays: 90,
        coverageTimeZone: 'Europe/Berlin',
      });
      expect(m.simDetailView).toHaveBeenCalledWith(
        SIM_ID,
        { userId: expect.any(String) as string, siteIds: null },
        5,
      );
    });
  });

  describe('POST /sims', () => {
    it('refuses an ICCID that is not one', async () => {
      const res = await call('POST', '/sims', { iccid: '1234' });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('VALIDATION_ERROR');
      expect(m.ensureSim).not.toHaveBeenCalled();
    });

    it('answers 200 created false for an ICCID already in the inventory and changes nothing', async () => {
      // The loser of a race and an existing ICCID look the same: ensureSim found it.
      m.ensureSim.mockResolvedValueOnce({ sim: simRow(), created: false });
      m.simViewById.mockResolvedValueOnce(simView());
      const res = await call('POST', '/sims', { iccid: '8900000000000000001F', label: 'New' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: SIM_ID, created: false, label: null });
      expect(m.updateSim).not.toHaveBeenCalled();
    });

    it('creates the SIM with its fields in one call (one created audit row)', async () => {
      m.ensureSim.mockResolvedValueOnce({ sim: simRow(), created: true });
      m.simViewById.mockResolvedValueOnce(simView({ label: 'Spare' }));
      const res = await call('POST', '/sims', {
        iccid: '8900000000000000001',
        label: 'Spare',
        imsi: '310150123456789',
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ created: true, label: 'Spare' });
      expect(m.ensureSim).toHaveBeenCalledWith(
        '8900000000000000001',
        expect.objectContaining({ fields: { imsi: '310150123456789', label: 'Spare' } }),
      );
      expect(m.updateSim).not.toHaveBeenCalled();
    });

    it('refuses an unknown body key', async () => {
      const res = await call('POST', '/sims', { iccid: '8900000000000000001', stationId: 'x' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('PATCH /sims/:id', () => {
    it('updates label, notes and IMSI and clears with null', async () => {
      m.visibleSim.mockResolvedValueOnce(simRow());
      m.updateSim.mockResolvedValueOnce({ before: {}, after: {} });
      m.simViewById.mockResolvedValueOnce(simView({ label: 'B' }));
      const res = await call('PATCH', `/sims/${SIM_ID}`, { label: 'B', notes: null });
      expect(res.statusCode).toBe(200);
      expect(m.updateSim).toHaveBeenCalledWith(
        SIM_ID,
        { label: 'B', notes: null },
        expect.anything(),
      );
    });

    it('refuses the ICCID and unknown keys', async () => {
      const res = await call('PATCH', `/sims/${SIM_ID}`, { iccid: '8900000000000000002' });
      expect(res.statusCode).toBe(400);
      expect(m.updateSim).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /sims/:id', () => {
    it('refuses a SIM with an open attachment with 409 SIM_ATTACHED', async () => {
      m.deleteSim.mockResolvedValueOnce({ kind: 'attached' });
      const res = await call('DELETE', `/sims/${SIM_ID}`);
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('SIM_ATTACHED');
    });

    it('deletes an unattached SIM', async () => {
      m.deleteSim.mockResolvedValueOnce({ kind: 'deleted', sim: simRow() });
      const res = await call('DELETE', `/sims/${SIM_ID}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('answers 404 for an unknown SIM', async () => {
      m.deleteSim.mockResolvedValueOnce({ kind: 'not_found' });
      const res = await call('DELETE', `/sims/${SIM_ID}`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe('deactivate and reactivate', () => {
    it('deactivates through the service and returns the CSMS status apart from the provider status', async () => {
      m.deactivateSim.mockResolvedValueOnce({ kind: 'changed' });
      m.simViewById.mockResolvedValueOnce(
        simView({
          status: 'inactive',
          deactivatedAt: NOW,
          deactivatedBy: USER_ID,
          lastStatus: {
            state: 'active',
            providerState: 'LIVE',
            inSession: null,
            openSessionBeganAt: null,
            apn: null,
            profileName: null,
            lastSessionAt: null,
            usage: null,
          },
        }),
      );
      const res = await call('POST', `/sims/${SIM_ID}/deactivate`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: 'inactive',
        deactivatedAt: NOW,
        deactivatedBy: USER_ID,
        lastStatus: { state: 'active' },
      });
      expect(m.reactivateSim).not.toHaveBeenCalled();
    });

    it('reactivates through the service', async () => {
      m.reactivateSim.mockResolvedValueOnce({ kind: 'unchanged', sim: simRow() });
      m.simViewById.mockResolvedValueOnce(simView());
      const res = await call('POST', `/sims/${SIM_ID}/reactivate`);
      expect(res.statusCode).toBe(200);
      expect(m.deactivateSim).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown SIM', async () => {
      m.reactivateSim.mockResolvedValueOnce({ kind: 'not_found' });
      const res = await call('POST', `/sims/${SIM_ID}/reactivate`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /sims/:id/attachments', () => {
    it('answers 404 STATION_NOT_FOUND for an unknown station', async () => {
      const res = await call('POST', `/sims/${SIM_ID}/attachments`, { stationId: STATION_ID });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('STATION_NOT_FOUND');
      expect(m.attachSim).not.toHaveBeenCalled();
    });

    it.each([
      ['station_has_sim', 409, 'STATION_HAS_SIM'],
      ['sim_attached_elsewhere', 409, 'SIM_ATTACHED_ELSEWHERE'],
      ['sim_inactive', 409, 'SIM_INACTIVE'],
      ['sim_not_found', 404, 'SIM_NOT_FOUND'],
    ])('maps %s to %i %s', async (kind, status, code) => {
      m.stationForAttach.mockResolvedValueOnce({ id: STATION_ID });
      m.attachSim.mockResolvedValueOnce({ kind });
      const res = await call('POST', `/sims/${SIM_ID}/attachments`, { stationId: STATION_ID });
      expect(res.statusCode).toBe(status);
      expect(res.json<{ code: string }>().code).toBe(code);
    });

    it('attaches confirmed and returns the attachment', async () => {
      m.stationForAttach.mockResolvedValueOnce({ id: STATION_ID });
      m.attachSim.mockResolvedValueOnce({ kind: 'attached', attachment: { id: 7 } });
      m.attachmentViewById.mockResolvedValueOnce(attachmentItem());
      const res = await call('POST', `/sims/${SIM_ID}/attachments`, { stationId: STATION_ID });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: 7, source: 'attached', confirmedAt: NOW });
    });
  });

  describe('detach and confirm on the SIM page', () => {
    it('answers 409 SIM_ATTACHMENT_CHANGED for a detach of an attachment no longer open', async () => {
      m.visibleSim.mockResolvedValueOnce(simRow());
      m.openSimAttachment.mockResolvedValueOnce({ id: 8, stationId: STATION_ID });
      const res = await call('POST', `/sims/${SIM_ID}/attachments/7/detach`);
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('SIM_ATTACHMENT_CHANGED');
      expect(m.detachSimAttachment).not.toHaveBeenCalled();
    });

    it.each([
      ['attachment_changed', 409, 'SIM_ATTACHMENT_CHANGED'],
      ['not_attached', 409, 'SIM_ATTACHMENT_CHANGED'],
      ['sim_inactive', 409, 'SIM_INACTIVE'],
    ])('maps a confirm result %s to %i %s', async (result, status, code) => {
      m.visibleSim.mockResolvedValueOnce(simRow());
      m.openSimAttachment.mockResolvedValueOnce({ id: 7, stationId: STATION_ID });
      m.confirmStationAttachment.mockResolvedValueOnce(result);
      const res = await call('POST', `/sims/${SIM_ID}/attachments/7/confirm`);
      expect(res.statusCode).toBe(status);
      expect(res.json<{ code: string }>().code).toBe(code);
    });

    it("confirms the station's open attachment the person saw", async () => {
      m.visibleSim.mockResolvedValueOnce(simRow());
      m.openSimAttachment
        .mockResolvedValueOnce({ id: 7, stationId: STATION_ID })
        .mockResolvedValueOnce({ id: 7, stationId: STATION_ID, confirmedAt: new Date(NOW) });
      m.confirmStationAttachment.mockResolvedValueOnce('confirmed');
      const res = await call('POST', `/sims/${SIM_ID}/attachments/7/confirm`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ confirmed: true, confirmedAt: NOW });
      expect(m.confirmStationAttachment).toHaveBeenCalledWith(STATION_ID, 7, expect.anything());
    });
  });

  describe('POST /sims/:id/refresh', () => {
    it('refuses an inactive SIM with 409 SIM_INACTIVE before any provider request', async () => {
      m.visibleSim.mockResolvedValueOnce(simRow({ status: 'inactive' }));
      const res = await call('POST', `/sims/${SIM_ID}/refresh`, {});
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('SIM_INACTIVE');
      expect(m.refreshSimProvider).not.toHaveBeenCalled();
      expect(keys.counts.size).toBe(0);
    });

    it('an all-site user refreshes any SIM, attached or not, confirmed or not', async () => {
      m.visibleSim.mockResolvedValueOnce(simRow());
      m.refreshSimProvider.mockResolvedValueOnce({
        result: 'ok',
        provider: 'hologram',
        fetchedAt: NOW,
        sessionsStored: 2,
        alertsStored: 0,
      });
      const res = await call('POST', `/sims/${SIM_ID}/refresh`, { days: 3 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ provider: { result: 'ok', sessionsStored: 2 } });
      expect(m.refreshSimProvider).toHaveBeenCalledWith(
        expect.objectContaining({ keys }),
        SIM_ID,
        expect.objectContaining({ mode: 'days' }),
        {},
      );
      expect(m.visibleSim).toHaveBeenCalledWith(SIM_ID, null);
    });

    it('refuses a period not offered', async () => {
      m.visibleSim.mockResolvedValueOnce(simRow());
      const res = await call('POST', `/sims/${SIM_ID}/refresh`, { days: 5 });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR', reason: 'days_not_offered' });
    });

    it('counts Refreshes per SIM and answers 429 over the limit', async () => {
      m.visibleSim.mockResolvedValue(simRow());
      m.refreshSimProvider.mockResolvedValue({ result: 'skipped', reason: 'provider_off' });
      for (let i = 0; i < SIM_PAGE_REFRESH_LIMIT_PER_MINUTE; i++) {
        expect((await call('POST', `/sims/${SIM_ID}/refresh`, {})).statusCode).toBe(200);
      }
      const res = await call('POST', `/sims/${SIM_ID}/refresh`, {});
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('42');
      expect(keys.counts.get(`sim:refresh:${SIM_ID}`)).toBe(SIM_PAGE_REFRESH_LIMIT_PER_MINUTE + 1);
      m.visibleSim.mockReset();
    });
  });

  describe('POST /sims/:id/network-reset', () => {
    it('answers 400 SIM_PROVIDER_NOT_CONFIGURED with no provider on', async () => {
      m.visibleSim.mockResolvedValueOnce(simRow());
      m.enabledProviders.mockResolvedValueOnce([]);
      const res = await call('POST', `/sims/${SIM_ID}/network-reset`);
      expect(res.statusCode).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('SIM_PROVIDER_NOT_CONFIGURED');
      expect(m.resetSimNetwork).not.toHaveBeenCalled();
    });

    it.each([
      [{ kind: 'sim_inactive' }, 409, 'SIM_INACTIVE'],
      [{ kind: 'not_looked_up' }, 404, 'SIM_NOT_FOUND'],
      [{ kind: 'provider_off' }, 400, 'SIM_PROVIDER_NOT_CONFIGURED'],
      [{ kind: 'unsupported' }, 409, 'SIM_ACTION_UNSUPPORTED'],
      [{ kind: 'cooldown', retryAfter: 30 }, 429, 'SIM_PROVIDER_RATE_LIMITED'],
      [{ kind: 'unavailable' }, 503, 'SIM_RESET_UNAVAILABLE'],
    ])('maps %o to %i %s', async (outcome, status, code) => {
      m.visibleSim.mockResolvedValueOnce(simRow());
      m.resetSimNetwork.mockResolvedValueOnce(outcome);
      const res = await call('POST', `/sims/${SIM_ID}/network-reset`);
      expect(res.statusCode).toBe(status);
      expect(res.json<{ code: string }>().code).toBe(code);
    });

    it('resets and records the command on the station the SIM is attached to', async () => {
      m.visibleSim.mockResolvedValueOnce(simRow());
      m.resetSimNetwork.mockImplementationOnce(
        async (
          _ctx: unknown,
          _simId: string,
          options: {
            onOutcome: (outcome: string, stationId: string | null) => Promise<void>;
          },
        ) => {
          await options.onOutcome('accepted', STATION_ID);
          return { kind: 'reset', status: 'accepted' };
        },
      );
      const res = await call('POST', `/sims/${SIM_ID}/network-reset`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'accepted' });
      expect(m.recordStationCommandAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          stationId: STATION_ID,
          command: 'SimNetworkReset',
          outcome: 'accepted',
        }),
        expect.anything(),
      );
    });
  });

  describe('GET /sims/:id/timeline', () => {
    it('refuses a cursor it did not hand out', async () => {
      m.simDetailView.mockResolvedValueOnce(detailView());
      const res = await call('GET', `/sims/${SIM_ID}/timeline?cursor=bad`);
      expect(res.statusCode).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('VALIDATION_ERROR');
    });

    it('refuses a page with a cursor, and reads the page asked for', async () => {
      m.simDetailView.mockResolvedValueOnce(detailView());
      const cursor = Buffer.from(`${new Date().toISOString()}|sim:alert|4`).toString('base64url');
      const both = await call('GET', `/sims/${SIM_ID}/timeline?page=2&cursor=${cursor}`);
      expect(both.statusCode).toBe(400);
      expect(both.json<{ code: string }>().code).toBe('VALIDATION_ERROR');

      m.simDetailView.mockResolvedValueOnce(detailView({ siteTimezone: 'UTC' }));
      const res = await call('GET', `/sims/${SIM_ID}/timeline?page=3&limit=25`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ total: 0, previousAt: null });
      expect(m.simTimelinePage).toHaveBeenLastCalledWith(
        SIM_ID,
        expect.anything(),
        { kind: 'page', page: 3, limit: 25 },
        null,
      );
    });

    it('caps the range at 31 days and returns the covered days', async () => {
      m.simDetailView.mockResolvedValueOnce(detailView({ siteTimezone: 'UTC' }));
      const res = await call(
        'GET',
        `/sims/${SIM_ID}/timeline?from=2020-01-01T00:00:00Z&to=2026-10-22T00:00:00Z`,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ capped: true, items: [], nextCursor: null, days: [] });
      expect(m.simCoveredDays).toHaveBeenCalled();
    });
  });
  describe('CSV export, template and import', () => {
    it('exports with the filters on screen and the user scope', async () => {
      setMockUserSiteIds([SITE_A]);
      const res = await call(
        'GET',
        '/sims/export?search=89&provider=hologram&attachment=attached&status=inactive&state=active&page=2&limit=5',
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('sims.csv');
      expect(res.body).toBe('csv');
      expect(m.exportSimsCsv).toHaveBeenCalledWith(
        {
          search: '89',
          provider: 'hologram',
          attachment: 'attached',
          status: 'inactive',
          state: 'active',
        },
        [SITE_A],
      );
    });

    it('exports every SIM the user sees with no filter', async () => {
      const res = await call('GET', '/sims/export');
      expect(res.statusCode).toBe(200);
      expect(m.exportSimsCsv).toHaveBeenCalledWith({}, null);
    });

    it('serves the template to an all-site user only', async () => {
      const ok = await call('GET', '/sims/export/template');
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['content-disposition']).toContain('sims-template.csv');
      setMockUserSiteIds([SITE_A]);
      const refused = await call('GET', '/sims/export/template');
      expect(refused.statusCode).toBe(404);
      expect(refused.json<{ code: string }>().code).toBe('SIM_NOT_FOUND');
    });

    it('refuses the import to a site-restricted user with 404, before any write', async () => {
      setMockUserSiteIds([SITE_A]);
      const res = await call('POST', '/sims/import', {
        rows: [{ iccid: '8900000000000000001' }],
        updateExisting: false,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('SIM_NOT_FOUND');
      expect(m.importSimsCsv).not.toHaveBeenCalled();
    });

    it('needs stations:write for rows that name a station', async () => {
      m.hasPermission.mockResolvedValue(false);
      const withStation = await call('POST', '/sims/import', {
        rows: [{ iccid: '8900000000000000001', stationId: 'CS-1' }],
        updateExisting: false,
      });
      expect(withStation.statusCode).toBe(403);
      expect(withStation.json<{ code: string }>().code).toBe('INSUFFICIENT_PERMISSIONS');
      const withoutStation = await call('POST', '/sims/import', {
        rows: [{ iccid: '8900000000000000001', stationId: ' ' }],
        updateExisting: true,
      });
      expect(withoutStation.statusCode).toBe(200);
      expect(m.importSimsCsv).toHaveBeenCalledWith(
        [{ iccid: '8900000000000000001', stationId: ' ' }],
        true,
        expect.objectContaining({ userId: USER_ID }),
        expect.anything(),
      );
    });

    it('refuses more than 10000 rows with 400', async () => {
      const rows = Array.from({ length: 10_001 }, () => ({ iccid: '8900000000000000001' }));
      const res = await call('POST', '/sims/import', { rows, updateExisting: false });
      expect(res.statusCode).toBe(400);
      expect(m.importSimsCsv).not.toHaveBeenCalled();
    });

    it('returns the per-row report', async () => {
      m.importSimsCsv.mockResolvedValueOnce({
        created: 1,
        updated: 0,
        attached: 1,
        errors: ['Row 2: invalid ICCID'],
      });
      const res = await call('POST', '/sims/import', {
        rows: [{ iccid: '8900000000000000001' }, { iccid: 'x' }],
        updateExisting: false,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        created: 1,
        updated: 0,
        attached: 1,
        errors: ['Row 2: invalid ICCID'],
      });
    });
  });
});
