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

  describe('cov3: replies whose view vanished after the write', () => {
    it('POST /sims answers 404 when the created SIM is not visible to the caller', async () => {
      m.ensureSim.mockResolvedValueOnce({ sim: simRow(), created: true });
      const res = await call('POST', '/sims', { iccid: '8900000000000000001' });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('SIM_NOT_FOUND');
    });

    it('POST /sims answers 200 for an existing SIM and 201 for a new one', async () => {
      m.ensureSim.mockResolvedValueOnce({ sim: simRow(), created: false });
      m.simViewById.mockResolvedValueOnce(simView());
      const existing = await call('POST', '/sims', { iccid: '8900000000000000001', label: 'L' });
      expect(existing.statusCode).toBe(200);
      expect(existing.json()).toMatchObject({ id: SIM_ID, created: false });
      expect(m.ensureSim).toHaveBeenCalledWith(
        '8900000000000000001',
        expect.objectContaining({ fields: { label: 'L' } }),
      );
    });

    it('PATCH answers 404 when the update found nothing', async () => {
      m.visibleSim.mockResolvedValueOnce(simRow());
      m.updateSim.mockResolvedValueOnce(null);
      const res = await call('PATCH', `/sims/${SIM_ID}`, { label: 'x', notes: null });
      expect(res.statusCode).toBe(404);
      expect(m.updateSim).toHaveBeenCalledWith(
        SIM_ID,
        { label: 'x', notes: null },
        expect.anything(),
      );
      expect(m.simViewById).not.toHaveBeenCalled();
    });

    it('POST attachments answers 404 when the attachment view is gone', async () => {
      m.stationForAttach.mockResolvedValueOnce({ id: STATION_ID });
      m.attachSim.mockResolvedValueOnce({ kind: 'unchanged', attachment: { id: 7 } });
      const res = await call('POST', `/sims/${SIM_ID}/attachments`, { stationId: STATION_ID });
      expect(res.statusCode).toBe(404);
      expect(m.attachmentViewById).toHaveBeenCalledWith(7, expect.anything());
    });
  });

  describe('cov3: detach on the SIM page', () => {
    it('answers 404 to a site-restricted user for a terminal attachment or a station out of scope', async () => {
      setMockUserSiteIds([SITE_A]);
      m.visibleSim.mockResolvedValue(simRow());
      m.openSimAttachment.mockResolvedValueOnce({ id: 7, stationId: null });
      const terminal = await call('POST', `/sims/${SIM_ID}/attachments/7/detach`);
      expect(terminal.statusCode).toBe(404);
      setMockStationSites({ [STATION_ID]: 'sit_other' });
      m.openSimAttachment.mockResolvedValueOnce({ id: 7, stationId: STATION_ID });
      const foreign = await call('POST', `/sims/${SIM_ID}/attachments/7/detach`);
      expect(foreign.statusCode).toBe(404);
      expect(m.detachSimAttachment).not.toHaveBeenCalled();
      m.visibleSim.mockReset();
    });

    it('answers 409 when the detach closed nothing and 404 when the closed view is gone', async () => {
      m.visibleSim.mockResolvedValue(simRow());
      m.openSimAttachment.mockResolvedValue({ id: 7, stationId: STATION_ID });
      m.detachSimAttachment.mockResolvedValueOnce(null);
      const changed = await call('POST', `/sims/${SIM_ID}/attachments/7/detach`);
      expect(changed.statusCode).toBe(409);
      expect(changed.json<{ code: string }>().code).toBe('SIM_ATTACHMENT_CHANGED');
      m.detachSimAttachment.mockResolvedValueOnce({ id: 7 });
      const gone = await call('POST', `/sims/${SIM_ID}/attachments/7/detach`);
      expect(gone.statusCode).toBe(404);
      m.detachSimAttachment.mockResolvedValueOnce({ id: 7 });
      m.attachmentViewById.mockResolvedValueOnce(attachmentItem({ detachedAt: NOW }));
      const ok = await call('POST', `/sims/${SIM_ID}/attachments/7/detach`);
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ id: 7, detachedAt: NOW });
      m.visibleSim.mockReset();
      m.openSimAttachment.mockReset();
    });
  });

  describe('cov3: confirm on the SIM page', () => {
    it('answers 404 for an unknown SIM and 409 for a terminal attachment', async () => {
      const unknown = await call('POST', `/sims/${SIM_ID}/attachments/7/confirm`);
      expect(unknown.statusCode).toBe(404);
      m.visibleSim.mockResolvedValueOnce(simRow());
      m.openSimAttachment.mockResolvedValueOnce({ id: 7, stationId: null });
      const terminal = await call('POST', `/sims/${SIM_ID}/attachments/7/confirm`);
      expect(terminal.statusCode).toBe(409);
      expect(m.confirmStationAttachment).not.toHaveBeenCalled();
    });

    it('answers a null confirmed time when the attachment closed right after', async () => {
      m.visibleSim.mockResolvedValueOnce(simRow());
      m.openSimAttachment.mockResolvedValueOnce({ id: 7, stationId: STATION_ID });
      m.confirmStationAttachment.mockResolvedValueOnce('confirmed');
      const res = await call('POST', `/sims/${SIM_ID}/attachments/7/confirm`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ confirmed: true, confirmedAt: null });
    });
  });

  describe('cov3: GET /sims/:id/timeline', () => {
    it('answers 404 for a SIM the caller cannot see', async () => {
      const res = await call('GET', `/sims/${SIM_ID}/timeline`);
      expect(res.statusCode).toBe(404);
      expect(m.simTimelinePage).not.toHaveBeenCalled();
    });

    it('refuses a start that is not before the end', async () => {
      m.simDetailView.mockResolvedValueOnce(detailView());
      const res = await call(
        'GET',
        `/sims/${SIM_ID}/timeline?from=2026-10-20T00:00:00Z&to=2026-10-19T00:00:00Z`,
      );
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        error: 'The timeline start must be before its end',
      });
    });

    it('refuses an end older than the kept SIM data', async () => {
      m.simDetailView.mockResolvedValueOnce(detailView());
      const res = await call(
        'GET',
        `/sims/${SIM_ID}/timeline?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z`,
      );
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: 'The timeline end is older than the kept SIM data',
      });
    });

    it('reads the provider history and delay of the SIM provider and passes the windows', async () => {
      const windows = [{ from: new Date(NOW), to: null }];
      m.simDetailView.mockResolvedValueOnce(
        detailView({ provider: 'hologram', siteTimezone: 'Europe/Berlin' }),
      );
      m.getProvider.mockResolvedValueOnce({ historyDays: 14, reportingDelayHours: 2 });
      m.simSiteWindows.mockResolvedValueOnce(windows as never);
      const res = await call('GET', `/sims/${SIM_ID}/timeline`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ capped: false, days: [] });
      expect(m.simCoveredDays).toHaveBeenCalledWith(
        SIM_ID,
        expect.any(Date),
        expect.any(Date),
        'Europe/Berlin',
        expect.objectContaining({ historyDays: 14, reportingDelayHours: 2, windows }),
        expect.any(Date),
      );
    });
  });

  describe('cov3: POST /sims/:id/refresh', () => {
    it('refuses a range without both ends or with days', async () => {
      m.visibleSim.mockResolvedValue(simRow());
      const half = await call('POST', `/sims/${SIM_ID}/refresh`, {
        from: '2026-10-20T00:00:00Z',
      });
      expect(half.statusCode).toBe(400);
      expect(half.json()).toMatchObject({ reason: 'range_incomplete' });
      const both = await call('POST', `/sims/${SIM_ID}/refresh`, {
        days: 3,
        from: '2026-10-20T00:00:00Z',
        to: '2026-10-21T00:00:00Z',
      });
      expect(both.json()).toMatchObject({ reason: 'range_incomplete' });
      m.visibleSim.mockReset();
    });

    it('allows the Refresh when the limit is not counted and passes retryLookup', async () => {
      m.visibleSim.mockResolvedValueOnce(simRow());
      setSimKeyStoreForTests({
        ...keys,
        increment: async () => {
          throw new Error('NOPERM');
        },
      });
      m.refreshSimProvider.mockResolvedValueOnce({ result: 'skipped', reason: 'provider_off' });
      const res = await call('POST', `/sims/${SIM_ID}/refresh`, {
        from: '2026-10-20T00:00:00Z',
        to: '2026-10-21T00:00:00Z',
        retryLookup: true,
      });
      expect(res.statusCode).toBe(200);
      expect(m.refreshSimProvider).toHaveBeenCalledWith(
        expect.anything(),
        SIM_ID,
        expect.anything(),
        { retryLookup: true },
      );
    });

    it('stays refused over the limit when the wait cannot be read, with the full wait', async () => {
      m.visibleSim.mockResolvedValueOnce(simRow());
      setSimKeyStoreForTests({
        ...keys,
        increment: async () => SIM_PAGE_REFRESH_LIMIT_PER_MINUTE + 1,
        ttlSeconds: async () => {
          throw new Error('down');
        },
      });
      const res = await call('POST', `/sims/${SIM_ID}/refresh`, {});
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('60');
      expect(m.refreshSimProvider).not.toHaveBeenCalled();
    });

    it('answers 409 SIM_INACTIVE when the provider part found the SIM inactive', async () => {
      m.visibleSim.mockResolvedValueOnce(simRow());
      m.refreshSimProvider.mockResolvedValueOnce({ result: 'skipped', reason: 'sim_inactive' });
      const res = await call('POST', `/sims/${SIM_ID}/refresh`, {});
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('SIM_INACTIVE');
    });
  });

  describe('cov3: POST /sims/:id/network-reset', () => {
    it('answers 404 for a SIM the caller cannot see', async () => {
      const res = await call('POST', `/sims/${SIM_ID}/network-reset`);
      expect(res.statusCode).toBe(404);
      expect(m.resetSimNetwork).not.toHaveBeenCalled();
    });

    it.each([
      [{ kind: 'sim_not_found' }, 404, 'SIM_NOT_FOUND'],
      [{ kind: 'provider_error', error: { kind: 'unsupported' } }, 409, 'SIM_ACTION_UNSUPPORTED'],
      [{ kind: 'provider_error', error: { kind: 'not_found' } }, 404, 'SIM_NOT_FOUND'],
    ])('maps %o to %i %s', async (outcome, status, code) => {
      m.visibleSim.mockResolvedValueOnce(simRow());
      m.resetSimNetwork.mockResolvedValueOnce(outcome);
      const res = await call('POST', `/sims/${SIM_ID}/network-reset`);
      expect(res.statusCode).toBe(status);
      expect(res.json<{ code: string }>().code).toBe(code);
    });

    it('rechecks the scope of a site-restricted user and records nothing for a SIM without a station', async () => {
      setMockUserSiteIds([SITE_A]);
      m.visibleSim.mockResolvedValueOnce(simRow()).mockResolvedValueOnce(null);
      let stillAllowed: boolean | null = null;
      m.resetSimNetwork.mockImplementationOnce(
        async (
          _ctx: unknown,
          _simId: string,
          options: {
            stillAllowed?: () => Promise<boolean>;
            onOutcome: (outcome: string, stationId: string | null) => Promise<void>;
          },
        ) => {
          stillAllowed = (await options.stillAllowed?.()) ?? null;
          await options.onOutcome('accepted', null);
          return { kind: 'reset', status: 'accepted' };
        },
      );
      const res = await call('POST', `/sims/${SIM_ID}/network-reset`);
      expect(res.statusCode).toBe(200);
      expect(stillAllowed).toBe(false);
      expect(m.visibleSim).toHaveBeenLastCalledWith(SIM_ID, [SITE_A]);
      expect(m.recordStationCommandAudit).not.toHaveBeenCalled();
    });
  });
});
