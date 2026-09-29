// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

let selectResults: unknown[][] = [];
let selectIndex = 0;

function makeSelectChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'offset']) chain[m] = vi.fn(() => chain);
  chain['then'] = (
    onF?: (v: unknown) => unknown,
    onR?: (r: unknown) => unknown,
  ): Promise<unknown> => Promise.resolve(selectResults[selectIndex++] ?? []).then(onF, onR);
  return chain;
}

function makeInsertChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    then: (onF?: (v: unknown) => unknown, onR?: (r: unknown) => unknown): Promise<unknown> =>
      Promise.resolve(undefined).then(onF, onR),
  };
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeSelectChain()),
    insert: vi.fn(() => makeInsertChain()),
  },
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
  sites: {},
  chargingStations: {},
  evses: {},
  connectors: {},
  ocpiPartners: { id: {}, countryCode: {}, partyId: {}, status: {} },
  ocpiPartnerEndpoints: { url: {}, partnerId: {}, module: {}, interfaceRole: {} },
  ocpiLocationPublish: {},
  ocpiLocationPublishPartners: {},
  ocpiRoamingSessions: {},
  ocpiTariffMappings: { partnerId: {}, updatedAt: {}, tariffId: {} },
  ocpiSyncLog: {},
  maintenanceEvents: {},
}));

vi.mock('../middleware/ocpi-auth.js', () => ({
  ocpiAuthenticate: vi.fn((request: { ocpiPartner?: unknown }) => {
    request.ocpiPartner = {
      partnerId: 'opr_1',
      partnerName: 'Partner',
      countryCode: 'DE',
      partyId: 'ABC',
      tokenId: 1,
    };
    return Promise.resolve();
  }),
}));

const putMock = vi.fn(() => Promise.resolve({}));
vi.mock('../lib/ocpi-client.js', () => ({
  OcpiClient: class {
    put = putMock;
  },
}));

vi.mock('../lib/outbound-token.js', () => ({
  getOutboundToken: vi.fn(() => Promise.resolve('outbound-token')),
}));

import { tariffInCurrency } from '../lib/tariff-currency.js';
import { cpoTariffRoutes } from '../routes/cpo/tariffs.js';
import { OcpiPushListener } from '../services/push.service.js';

const STORED_TARIFF = {
  id: 'T-1',
  country_code: 'US',
  party_id: 'EVT',
  currency: 'USD',
  elements: [],
};

beforeEach(() => {
  selectResults = [];
  selectIndex = 0;
  putMock.mockClear();
});

describe('tariffInCurrency', () => {
  it('replaces the stored currency and keeps every other field', () => {
    expect(tariffInCurrency(STORED_TARIFF, 'EUR')).toEqual({ ...STORED_TARIFF, currency: 'EUR' });
  });
});

describe('CPO tariffs endpoint', () => {
  it('serves stored tariffs in the company currency', async () => {
    selectResults = [[{ ocpiTariffData: STORED_TARIFF }], [{ count: 1 }]];
    const app = Fastify();
    cpoTariffRoutes(app);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/ocpi/2.2.1/cpo/tariffs' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ id: string; currency: string }> }>();
    expect(body.data).toEqual([expect.objectContaining({ id: 'T-1', currency: 'EUR' })]);
    await app.close();
  });
});

describe('tariff push', () => {
  it('pushes the tariff in the company currency', async () => {
    selectResults = [
      [
        {
          tariffId: 'trf_1',
          partnerId: 'opr_1',
          ocpiTariffId: 'T-1',
          ocpiTariffData: STORED_TARIFF,
        },
      ],
      [{ url: 'http://127.0.0.1/tariffs' }],
      [{ countryCode: 'DE', partyId: 'ABC' }],
    ];
    let handler: ((payload: string) => void) | undefined;
    const pubsub = {
      subscribe: vi.fn((_channel: string, cb: (payload: string) => void) => {
        handler = cb;
        return Promise.resolve({ unsubscribe: vi.fn() });
      }),
    };
    const listener = new OcpiPushListener(pubsub as never);
    await listener.start();

    handler?.(JSON.stringify({ type: 'tariff', tariffId: 'trf_1' }));
    await vi.waitFor(() => {
      expect(putMock).toHaveBeenCalled();
    });

    expect(putMock).toHaveBeenCalledWith(
      expect.stringContaining('/T-1'),
      expect.objectContaining({ id: 'T-1', currency: 'EUR' }),
    );
  });
});
