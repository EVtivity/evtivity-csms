// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Each awaited select chain resolves to the next queued result.
let selectResults: unknown[][] = [];
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(selectResults.shift() ?? []).then(resolve);
  return chain;
}
function makeInsertChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = { values: vi.fn(() => chain) };
  chain['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
  return chain;
}

const mocks = vi.hoisted(() => ({
  client: { put: vi.fn(), delete: vi.fn() },
  partnerTariffMappings: vi.fn(),
  renderTariffMapping: vi.fn(),
  mappingsForPricingChange: vi.fn(),
  cpoSessionLink: vi.fn(),
  renderCpoSession: vi.fn(),
  syncCpoSessionRow: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: { select: vi.fn(() => makeChain()), insert: vi.fn(() => makeInsertChain()) },
  sites: {},
  chargingStations: {},
  chargingSessions: { id: {} },
  evses: {},
  connectors: {},
  ocpiPartners: { id: {}, status: {} },
  ocpiPartnerEndpoints: {},
  ocpiLocationPublish: {},
  ocpiLocationPublishPartners: {},
  ocpiSyncLog: {},
  maintenanceEvents: {},
  isStationLevelUnavailable: vi.fn(),
}));
vi.mock('../lib/ocpi-client.js', () => ({
  OcpiClient: vi.fn(function OcpiClient() {
    return mocks.client;
  }),
}));
vi.mock('../lib/outbound-token.js', () => ({ getOutboundToken: vi.fn(async () => 'token') }));
vi.mock('../services/published-tariffs.js', () => ({
  partnerTariffMappings: mocks.partnerTariffMappings,
  renderTariffMapping: mocks.renderTariffMapping,
  mappingsForPricingChange: mocks.mappingsForPricingChange,
}));
vi.mock('../services/cpo-sessions.js', () => ({
  cpoSessionLink: mocks.cpoSessionLink,
  renderCpoSession: mocks.renderCpoSession,
  syncCpoSessionRow: mocks.syncCpoSessionRow,
}));

const { OcpiPushListener } = await import('../services/push.service.js');

type Handler = (payload: string) => void;
let handler: Handler = () => undefined;
const pubsub = {
  subscribe: vi.fn(async (_channel: string, h: Handler) => {
    handler = h;
    return { unsubscribe: vi.fn() };
  }),
  publish: vi.fn(),
};

const PARTNER = { countryCode: 'NL', partyId: 'MSP', version: '2.3.0' };
const URL = 'https://partner.example/ocpi/2.3.0/tariffs';

beforeEach(async () => {
  selectResults = [];
  vi.clearAllMocks();
  await new OcpiPushListener(pubsub as never).start();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('tariff push', () => {
  it('PUTs the tariff generated for the partner in its version', async () => {
    const mapping = { id: 1, ocpiTariffId: 'T-1', partnerId: 'opr_1' };
    const tariff = { id: 'T-1', elements: [], tax_included: 'NO' };
    mocks.partnerTariffMappings.mockResolvedValue([mapping]);
    mocks.renderTariffMapping.mockResolvedValue(tariff);
    selectResults = [[{ url: URL }], [PARTNER]];

    handler(
      JSON.stringify({ type: 'tariff', targets: [{ partnerId: 'opr_1', ocpiTariffId: 'T-1' }] }),
    );
    await settle();

    expect(mocks.renderTariffMapping).toHaveBeenCalledWith(mapping, '2.3.0');
    expect(mocks.client.put).toHaveBeenCalledWith(`${URL}/US/EVT/T-1`, tariff);
    expect(mocks.client.delete).not.toHaveBeenCalled();
  });

  it('DELETEs the tariff at the partner when no mapping publishes the id any more', async () => {
    mocks.partnerTariffMappings.mockResolvedValue([]);
    selectResults = [[{ url: URL }], [PARTNER]];

    handler(
      JSON.stringify({ type: 'tariff', targets: [{ partnerId: 'opr_1', ocpiTariffId: 'T-1' }] }),
    );
    await settle();

    expect(mocks.client.delete).toHaveBeenCalledWith(`${URL}/US/EVT/T-1`);
    expect(mocks.client.put).not.toHaveBeenCalled();
  });

  it('pushes a global mapping to every connected partner', async () => {
    mocks.partnerTariffMappings.mockResolvedValue([
      { id: 1, ocpiTariffId: 'T-1', partnerId: null },
    ]);
    mocks.renderTariffMapping.mockResolvedValue({ id: 'T-1', elements: [] });
    selectResults = [
      [{ id: 'opr_1' }, { id: 'opr_2' }], // connected partners
      [{ url: URL }],
      [PARTNER],
      [{ url: URL }],
      [{ ...PARTNER, version: '2.2.1' }],
    ];

    handler(
      JSON.stringify({ type: 'tariff', targets: [{ partnerId: null, ocpiTariffId: 'T-1' }] }),
    );
    await settle();

    expect(mocks.partnerTariffMappings).toHaveBeenCalledWith('opr_1');
    expect(mocks.partnerTariffMappings).toHaveBeenCalledWith('opr_2');
    expect(mocks.client.put).toHaveBeenCalledTimes(2);
  });

  it('pushes every mapping generated from a changed pricing group', async () => {
    mocks.mappingsForPricingChange.mockResolvedValue([
      { id: 1, ocpiTariffId: 'T-1', partnerId: 'opr_1' },
    ]);
    mocks.partnerTariffMappings.mockResolvedValue([
      { id: 1, ocpiTariffId: 'T-1', partnerId: 'opr_1' },
    ]);
    mocks.renderTariffMapping.mockResolvedValue({ id: 'T-1', elements: [] });
    selectResults = [[{ url: URL }], [PARTNER]];

    handler(JSON.stringify({ type: 'tariff', pricingGroupId: 'pgr_1', tariffId: 'trf_1' }));
    await settle();

    expect(mocks.mappingsForPricingChange).toHaveBeenCalledWith({
      tariffId: 'trf_1',
      pricingGroupId: 'pgr_1',
    });
    expect(mocks.client.put).toHaveBeenCalledWith(`${URL}/US/EVT/T-1`, expect.anything());
  });

  it('skips a partner without a tariffs receiver', async () => {
    mocks.partnerTariffMappings.mockResolvedValue([]);
    selectResults = [[], [PARTNER]];
    handler(
      JSON.stringify({ type: 'tariff', targets: [{ partnerId: 'opr_1', ocpiTariffId: 'T-1' }] }),
    );
    await settle();
    expect(mocks.client.put).not.toHaveBeenCalled();
    expect(mocks.client.delete).not.toHaveBeenCalled();
  });
});

describe('session push', () => {
  const link = { id: 7, partnerId: 'opr_1', chargingSessionId: 'ses_1', tokenUid: 'TOKEN-1' };
  const ocpiSession = { id: 'tx-1', status: 'ACTIVE' };

  it('renders our CPO session, updates the link row, and PUTs it', async () => {
    mocks.cpoSessionLink.mockResolvedValue(link);
    mocks.renderCpoSession.mockResolvedValue(ocpiSession);
    selectResults = [[{ id: 'ses_1' }], [PARTNER], [{ url: 'https://p/sessions' }]];

    handler(JSON.stringify({ type: 'session', sessionId: 'ses_1' }));
    await settle();

    expect(mocks.renderCpoSession).toHaveBeenCalledWith(link, { id: 'ses_1' }, '2.3.0');
    expect(mocks.syncCpoSessionRow).toHaveBeenCalledWith(link, ocpiSession, '2.3.0');
    expect(mocks.client.put).toHaveBeenCalledWith('https://p/sessions/US/EVT/tx-1', ocpiSession);
  });

  it('does nothing for a session no partner token started', async () => {
    mocks.cpoSessionLink.mockResolvedValue(null);
    handler(JSON.stringify({ type: 'session', sessionId: 'ses_1' }));
    await settle();
    expect(mocks.renderCpoSession).not.toHaveBeenCalled();
    expect(mocks.client.put).not.toHaveBeenCalled();
  });
});
