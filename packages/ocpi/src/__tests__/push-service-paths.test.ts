// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Each awaited select chain resolves to the next queued result; inserts record
// the sync-log rows the push wrote.
let selectResults: unknown[][] = [];
let syncLogs: Array<Record<string, unknown>> = [];
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'innerJoin', 'leftJoin'])
    chain[m] = vi.fn(() => chain);
  chain['then'] = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(selectResults.shift() ?? []).then(resolve, reject);
  return chain;
}
function makeInsertChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    values: vi.fn((v: Record<string, unknown>) => {
      syncLogs.push(v);
      return chain;
    }),
  };
  chain['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
  return chain;
}

const mocks = vi.hoisted(() => ({
  client: { put: vi.fn(), delete: vi.fn(), patch: vi.fn() },
  getOutboundToken: vi.fn(),
  partnerTariffMappings: vi.fn(),
  renderTariffMapping: vi.fn(),
  mappingsForPricingChange: vi.fn(),
  cpoSessionLink: vi.fn(),
  renderCpoSession: vi.fn(),
  syncCpoSessionRow: vi.fn(),
  loadSiteLocation: vi.fn(),
  connectorTariffIds: vi.fn(),
  ocpiLocationAudience: vi.fn(),
  transformLocation: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    selectDistinct: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeInsertChain()),
  },
  chargingStations: {},
  chargingSessions: { id: {} },
  evses: {},
  ocpiPartners: { id: {}, status: {} },
  ocpiPartnerEndpoints: {},
  ocpiLocationPublish: {},
  ocpiLocationPublishPartners: {},
  ocpiSyncLog: {},
  ocpiLocationAudience: mocks.ocpiLocationAudience,
}));
vi.mock('../lib/ocpi-client.js', () => ({
  OcpiClient: vi.fn(function OcpiClient() {
    return mocks.client;
  }),
}));
vi.mock('../lib/outbound-token.js', () => ({ getOutboundToken: mocks.getOutboundToken }));
vi.mock('../transformers/location.transformer.js', () => ({
  transformLocation: mocks.transformLocation,
}));
vi.mock('../services/published-tariffs.js', () => ({
  partnerTariffMappings: mocks.partnerTariffMappings,
  renderTariffMapping: mocks.renderTariffMapping,
  mappingsForPricingChange: mocks.mappingsForPricingChange,
}));
vi.mock('../services/location-render.js', () => ({
  loadSiteLocation: mocks.loadSiteLocation,
  withTariffIds: (input: unknown) => input,
}));
vi.mock('../services/connector-tariffs.js', () => ({
  connectorTariffIds: mocks.connectorTariffIds,
}));
vi.mock('../services/cpo-sessions.js', () => ({
  cpoSessionLink: mocks.cpoSessionLink,
  renderCpoSession: mocks.renderCpoSession,
  syncCpoSessionRow: mocks.syncCpoSessionRow,
}));

const { OcpiPushListener, pushLegacyEvseRemoval } = await import('../services/push.service.js');

type Handler = (payload: string) => void;
const unsubscribe = vi.fn(async () => undefined);
let handler: Handler = () => undefined;
const pubsub = {
  subscribe: vi.fn(async (_channel: string, h: Handler) => {
    handler = h;
    return { unsubscribe };
  }),
  publish: vi.fn(),
};

const PARTNER = {
  countryCode: 'NL',
  partyId: 'MSP',
  version: '2.2.1',
  allowPrivateNetwork: false,
};

/** Delivers notifications to a fresh listener and waits for them via stop() (drain). */
async function deliver(
  notifications: Array<Record<string, unknown> | string>,
  onCompleted: ((id: string) => Promise<void>) | null = null,
): Promise<void> {
  const listener = new OcpiPushListener(pubsub as never, onCompleted);
  await listener.start();
  for (const n of notifications) handler(typeof n === 'string' ? n : JSON.stringify(n));
  await listener.stop();
}

beforeEach(() => {
  selectResults = [];
  syncLogs = [];
  mocks.client.put.mockReset();
  mocks.client.put.mockResolvedValue({ status_code: 1000, status_message: 'OK' });
  mocks.client.delete.mockReset();
  mocks.client.delete.mockResolvedValue({ status_code: 1000 });
  mocks.client.patch.mockReset();
  mocks.client.patch.mockResolvedValue({ status_code: 1000, status_message: 'OK' });
  mocks.getOutboundToken.mockReset();
  mocks.getOutboundToken.mockResolvedValue('token');
  mocks.transformLocation.mockImplementation((input: { ocpiLocationId: string }) => ({
    id: input.ocpiLocationId,
  }));
  mocks.connectorTariffIds.mockResolvedValue(new Map());
});

describe('listener lifecycle and payloads', () => {
  it('unsubscribes on stop and ignores invalid JSON and cdr notifications', async () => {
    await deliver(['{nope', { type: 'cdr', cdrId: 'CDR-1' }]);

    expect(pubsub.subscribe).toHaveBeenCalledWith('ocpi_push', expect.any(Function));
    expect(unsubscribe).toHaveBeenCalled();
    expect(mocks.client.put).not.toHaveBeenCalled();
    expect(syncLogs).toHaveLength(0);
  });

  it('ignores location and session notifications without an id', async () => {
    await deliver([{ type: 'location' }, { type: 'session' }]);
    expect(mocks.ocpiLocationAudience).not.toHaveBeenCalled();
    expect(mocks.cpoSessionLink).not.toHaveBeenCalled();
  });
});

describe('location push', () => {
  const location = { input: { ocpiLocationId: 'LOC-1' }, stations: [] };

  it('skips an unpublished site but still sends REMOVED to partners that lost it', async () => {
    mocks.ocpiLocationAudience.mockResolvedValue(null);
    mocks.loadSiteLocation.mockResolvedValue({ input: { ocpiLocationId: 'OLD-1' }, stations: [] });
    selectResults = [[{ url: 'https://p/locations' }], [PARTNER]];

    await deliver([
      {
        type: 'location',
        siteId: 'sit_1',
        removed: { ocpiLocationId: 'OLD-1', partnerIds: ['opr_1'] },
      },
    ]);

    expect(mocks.loadSiteLocation).toHaveBeenCalledWith('sit_1', 'OLD-1');
    expect(mocks.transformLocation).toHaveBeenCalledWith(
      { ocpiLocationId: 'OLD-1', allRemoved: true },
      '2.2.1',
    );
    // A removed location carries no tariffs.
    expect(mocks.connectorTariffIds).not.toHaveBeenCalled();
    expect(mocks.client.put).toHaveBeenCalledWith('https://p/locations/US/EVT/OLD-1', {
      id: 'OLD-1',
    });
    expect(syncLogs).toEqual([
      expect.objectContaining({ action: 'push_removed', status: 'completed', objectsCount: '1' }),
    ]);
  });

  it('logs a failed push with the error message when the partner PUT throws', async () => {
    mocks.ocpiLocationAudience.mockResolvedValue({
      ocpiLocationId: 'LOC-1',
      partnerIds: ['opr_1'],
    });
    mocks.loadSiteLocation.mockResolvedValue(location);
    mocks.client.put.mockRejectedValue(new Error('socket hang up'));
    selectResults = [[{ url: 'https://p/locations' }], [PARTNER]];

    await deliver([{ type: 'location', siteId: 'sit_1' }]);

    expect(syncLogs).toEqual([
      expect.objectContaining({
        module: 'locations',
        direction: 'push',
        action: 'push_update',
        status: 'failed',
        objectsCount: '0',
        errorMessage: 'socket hang up',
      }),
    ]);
  });

  it('skips a partner without an outbound token', async () => {
    mocks.ocpiLocationAudience.mockResolvedValue({
      ocpiLocationId: 'LOC-1',
      partnerIds: ['opr_1'],
    });
    mocks.loadSiteLocation.mockResolvedValue(location);
    mocks.getOutboundToken.mockResolvedValue(null);
    selectResults = [[{ url: 'https://p/locations' }], [PARTNER]];

    await deliver([{ type: 'location', siteId: 'sit_1' }]);

    expect(mocks.client.put).not.toHaveBeenCalled();
    expect(syncLogs).toHaveLength(0);
  });

  it('skips a partner whose row is gone', async () => {
    mocks.ocpiLocationAudience.mockResolvedValue({
      ocpiLocationId: 'LOC-1',
      partnerIds: ['opr_1'],
    });
    mocks.loadSiteLocation.mockResolvedValue(location);
    selectResults = [[{ url: 'https://p/locations' }], []];

    await deliver([{ type: 'location', siteId: 'sit_1' }]);

    expect(mocks.client.put).not.toHaveBeenCalled();
  });

  it('pushes nothing when the site location cannot be loaded', async () => {
    mocks.ocpiLocationAudience.mockResolvedValue({
      ocpiLocationId: 'LOC-1',
      partnerIds: ['opr_1'],
    });
    mocks.loadSiteLocation.mockResolvedValue(null);

    await deliver([
      {
        type: 'location',
        siteId: 'sit_1',
        removed: { ocpiLocationId: 'X', partnerIds: ['opr_2'] },
      },
    ]);

    expect(mocks.client.put).not.toHaveBeenCalled();
  });
});

describe('pushLegacyEvseRemoval', () => {
  it('skips sites whose location no longer loads but still PATCHes their old uids', async () => {
    selectResults = [
      [{ url: 'https://p/locations' }],
      [PARTNER],
      [{ siteId: 'sit_1', ocpiLocationId: null, evseNumber: 2 }],
    ];
    mocks.loadSiteLocation.mockResolvedValue(null);

    const sent = await pushLegacyEvseRemoval('opr_1');

    expect(sent).toBe(1);
    expect(mocks.client.put).not.toHaveBeenCalled();
    expect(mocks.client.patch).toHaveBeenCalledWith(
      'https://p/locations/US/EVT/sit_1/sit_1-2',
      expect.objectContaining({ status: 'REMOVED' }),
    );
    expect(syncLogs).toEqual([
      expect.objectContaining({ action: 'push_removed_legacy', objectsCount: '1' }),
    ]);
  });

  it('returns null without a token', async () => {
    selectResults = [[{ url: 'https://p/locations' }], [PARTNER]];
    mocks.getOutboundToken.mockResolvedValue(null);

    expect(await pushLegacyEvseRemoval('opr_1')).toBeNull();
  });
});

describe('session push', () => {
  const link = { id: 7, partnerId: 'opr_1', chargingSessionId: 'ses_1' };
  const ocpiSession = { id: 'tx-1', status: 'COMPLETED' };
  const COMPLETED = { id: 'ses_1', status: 'completed', endedAt: new Date() };

  beforeEach(() => {
    mocks.cpoSessionLink.mockResolvedValue(link);
    mocks.renderCpoSession.mockResolvedValue(ocpiSession);
    mocks.syncCpoSessionRow.mockResolvedValue(undefined);
  });

  it('stops when the charging session is gone', async () => {
    selectResults = [[]];
    await deliver([{ type: 'session', sessionId: 'ses_1' }]);
    expect(mocks.renderCpoSession).not.toHaveBeenCalled();
  });

  it('stops when the partner is gone', async () => {
    selectResults = [[COMPLETED], []];
    await deliver([{ type: 'session', sessionId: 'ses_1' }]);
    expect(mocks.renderCpoSession).not.toHaveBeenCalled();
  });

  it('stops when the session cannot be rendered', async () => {
    mocks.renderCpoSession.mockResolvedValue(null);
    selectResults = [[COMPLETED], [PARTNER]];
    await deliver([{ type: 'session', sessionId: 'ses_1' }]);
    expect(mocks.syncCpoSessionRow).not.toHaveBeenCalled();
    expect(mocks.client.put).not.toHaveBeenCalled();
  });

  it('still pushes the session when CDR scheduling fails', async () => {
    const onCompleted = vi.fn(async () => {
      throw new Error('redis down');
    });
    selectResults = [[COMPLETED], [PARTNER], [{ url: 'https://p/sessions' }]];

    await deliver([{ type: 'session', sessionId: 'ses_1' }], onCompleted);

    expect(onCompleted).toHaveBeenCalledWith('ses_1');
    expect(mocks.client.put).toHaveBeenCalledWith('https://p/sessions/US/EVT/tx-1', ocpiSession);
    expect(syncLogs).toEqual([
      expect.objectContaining({ module: 'sessions', action: 'push_update', status: 'completed' }),
    ]);
  });

  it('updates the link row but sends nothing without a sessions receiver', async () => {
    selectResults = [[COMPLETED], [PARTNER], []];
    await deliver([{ type: 'session', sessionId: 'ses_1' }]);
    expect(mocks.syncCpoSessionRow).toHaveBeenCalled();
    expect(mocks.client.put).not.toHaveBeenCalled();
  });

  it('sends nothing without an outbound token', async () => {
    mocks.getOutboundToken.mockResolvedValue(null);
    selectResults = [[COMPLETED], [PARTNER], [{ url: 'https://p/sessions' }]];
    await deliver([{ type: 'session', sessionId: 'ses_1' }]);
    expect(mocks.client.put).not.toHaveBeenCalled();
  });

  it('logs a failed session push', async () => {
    mocks.client.put.mockRejectedValue(new Error('timeout'));
    selectResults = [[COMPLETED], [PARTNER], [{ url: 'https://p/sessions' }]];

    await deliver([{ type: 'session', sessionId: 'ses_1' }]);

    expect(syncLogs).toEqual([
      expect.objectContaining({
        module: 'sessions',
        status: 'failed',
        errorMessage: 'timeout',
      }),
    ]);
  });

  it('logs a generic message for a non-Error failure', async () => {
    mocks.client.put.mockRejectedValue('nope');
    selectResults = [[COMPLETED], [PARTNER], [{ url: 'https://p/sessions' }]];

    await deliver([{ type: 'session', sessionId: 'ses_1' }]);

    expect(syncLogs[0]).toMatchObject({ status: 'failed', errorMessage: 'Push failed' });
  });
});

describe('tariff push', () => {
  const target = { type: 'tariff', targets: [{ partnerId: 'opr_1', ocpiTariffId: 'T-1' }] };

  it('does nothing when a pricing change maps to no published tariff', async () => {
    mocks.mappingsForPricingChange.mockResolvedValue([]);

    await deliver([{ type: 'tariff', tariffId: 'trf_1' }]);

    expect(mocks.mappingsForPricingChange).toHaveBeenCalledWith({
      tariffId: 'trf_1',
      pricingGroupId: null,
    });
    expect(mocks.partnerTariffMappings).not.toHaveBeenCalled();
  });

  it('skips a partner without a token', async () => {
    mocks.getOutboundToken.mockResolvedValue(null);
    selectResults = [[{ url: 'https://p/tariffs' }], [PARTNER]];

    await deliver([target]);

    expect(mocks.partnerTariffMappings).not.toHaveBeenCalled();
    expect(mocks.client.put).not.toHaveBeenCalled();
  });

  it('skips a partner whose row is gone', async () => {
    selectResults = [[{ url: 'https://p/tariffs' }], []];

    await deliver([target]);

    expect(mocks.partnerTariffMappings).not.toHaveBeenCalled();
  });

  it('logs a failed tariff push', async () => {
    selectResults = [[{ url: 'https://p/tariffs' }], [PARTNER]];
    mocks.partnerTariffMappings.mockResolvedValue([]);
    mocks.client.delete.mockRejectedValue(new Error('HTTP 500'));

    await deliver([target]);

    expect(syncLogs).toEqual([
      expect.objectContaining({
        module: 'tariffs',
        action: 'push_update',
        status: 'failed',
        errorMessage: 'HTTP 500',
      }),
    ]);
  });

  it('logs a completed delete', async () => {
    selectResults = [[{ url: 'https://p/tariffs' }], [PARTNER]];
    mocks.partnerTariffMappings.mockResolvedValue([]);

    await deliver([target]);

    expect(mocks.client.delete).toHaveBeenCalledWith('https://p/tariffs/US/EVT/T-1');
    expect(syncLogs).toEqual([
      expect.objectContaining({ action: 'push_delete', status: 'completed' }),
    ]);
  });
});
