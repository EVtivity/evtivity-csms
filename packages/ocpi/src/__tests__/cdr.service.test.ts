// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Each awaited select chain resolves to the next queued result; inserts are recorded.
let selectResults: unknown[][] = [];
let inserted: Record<string, unknown>[] = [];
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'for']) chain[m] = vi.fn(() => chain);
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(selectResults.shift() ?? []).then(resolve);
  return chain;
}
function makeInsertChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    values: vi.fn((v: Record<string, unknown>) => {
      inserted.push(v);
      return chain;
    }),
  };
  chain['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
  return chain;
}

let updates: Record<string, unknown>[] = [];
function makeUpdateChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    set: vi.fn((v: Record<string, unknown>) => {
      updates.push(v);
      return chain;
    }),
    where: vi.fn(() => chain),
  };
  chain['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
  return chain;
}

const mocks = vi.hoisted(() => ({
  cpoSessionLink: vi.fn(),
  getOutboundToken: vi.fn(),
  post: vi.fn(),
  ocpiCdrCost: vi.fn(),
  sessionTariffMapping: vi.fn(),
  renderSnapshotTariff: vi.fn(),
  sessionCdrParts: vi.fn(),
  createCreditCdr: vi.fn(),
  notifyRoamingCdrChanged: vi.fn(),
}));

vi.mock('@evtivity/database', () => {
  const db = {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeInsertChain()),
    update: vi.fn(() => makeUpdateChain()),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return {
    db,
    chargingSessions: { id: {} },
    ocpiCdrs: { ocpiCdrId: {}, id: {}, chargingSessionId: {}, isCredit: {} },
    ocpiRoamingSessions: { id: {}, chargingSessionId: {}, tokenUid: {} },
    ocpiPartnerEndpoints: {},
    ocpiPartners: { id: {}, version: {} },
    ocpiSyncLog: {},
    createCreditCdr: mocks.createCreditCdr,
  };
});
vi.mock('../lib/pubsub.js', () => ({ notifyRoamingCdrChanged: mocks.notifyRoamingCdrChanged }));
vi.mock('../lib/outbound-token.js', () => ({ getOutboundToken: mocks.getOutboundToken }));
vi.mock('../lib/ocpi-client.js', () => ({
  OcpiClient: vi.fn(function OcpiClient() {
    return { post: mocks.post };
  }),
}));
vi.mock('../services/session-cost-split.js', () => ({
  ocpiCdrCost: mocks.ocpiCdrCost,
  idleMinutesAt: () => 0,
}));
vi.mock('../services/cpo-sessions.js', () => ({
  cpoSessionLink: mocks.cpoSessionLink,
  sessionPlace: vi.fn(async () => ({
    siteId: 'sit_1',
    site: null,
    locationId: 'LOC-1',
    evseUid: 'evs_1',
    evseId: 'CS-1-EVSE-1',
    connectorId: '1',
    connectorType: 'Type2',
  })),
  partnerToken: vi.fn(async (_partnerId: string, uid: string) => ({
    uid,
    countryCode: 'NL',
    partyId: 'MSP',
  })),
}));
vi.mock('../services/published-tariffs.js', () => ({
  sessionTariffMapping: mocks.sessionTariffMapping,
  renderSnapshotTariff: mocks.renderSnapshotTariff,
}));
vi.mock('../services/cdr-parts.js', () => ({
  sessionCdrParts: mocks.sessionCdrParts,
  partTimes: (parts: Array<{ segment: number | null; period: Record<string, number> }>) =>
    parts.map((p) => ({
      segment: p.segment,
      chargingMinutes: p.period['chargingMinutes'],
      idleMinutes: p.period['idleMinutes'],
    })),
}));

const { buildSessionCdr, issueSessionCdr, pushCdr, generateCreditCdr } =
  await import('../services/cdr.service.js');

const startedAt = new Date('2026-09-01T10:00:00Z');
const endedAt = new Date('2026-09-01T11:00:00Z');
const SESSION = {
  id: 'ses_1',
  status: 'completed',
  transactionId: 'tx-1',
  stationId: 'sta_1',
  evseId: null,
  connectorId: null,
  startedAt,
  endedAt,
  energyDeliveredWh: '10000',
  finalCostCents: 476,
  currency: 'eur',
  tariffId: 'trf_1',
};

function primeGenerate(version: string): void {
  selectResults = [[{ version }]];
}

const PRICES = {
  id: 'trf_1',
  pricePerKwh: '0.40',
  pricePerMinute: '0.02',
  pricePerSession: null,
  idleFeePricePerMinute: '0.10',
  reservationFeePerMinute: null,
  taxRate: '0.19',
  restrictions: null,
  priority: 0,
  isDefault: true,
  isActive: true,
};
/** The whole session as one priced part: 45 minutes charging, 15 idle, 5 of them billed. */
const SINGLE_PART = {
  segment: null,
  tariffId: 'trf_1',
  prices: PRICES,
  period: { startedAt, kwh: 10, chargingMinutes: 45, idleMinutes: 15, billableIdleMinutes: 5 },
};

const LINK = {
  id: 7,
  partnerId: 'opr_1',
  ocpiSessionId: 'ses_1',
  chargingSessionId: 'ses_1',
  tokenUid: 'TOKEN-1',
};

async function generateCdr(sessionId: string, partnerId: string, ocpiSessionId = sessionId) {
  const built = await buildSessionCdr({ ...SESSION, id: sessionId } as never, {
    ...LINK,
    partnerId,
    chargingSessionId: sessionId,
    ocpiSessionId,
  });
  if (built != null) inserted.push(built.row);
  return built?.cdr ?? null;
}

beforeEach(() => {
  selectResults = [];
  inserted = [];
  updates = [];
  vi.clearAllMocks();
  mocks.ocpiCdrCost.mockReturnValue({
    total: [{ taxRate: 0.19, netCents: 400, taxCents: 76 }],
  });
  mocks.sessionTariffMapping.mockResolvedValue(null);
  mocks.sessionCdrParts.mockResolvedValue([SINGLE_PART]);
  mocks.renderSnapshotTariff.mockImplementation(async (input: { ocpiTariffId: string }) => ({
    id: input.ocpiTariffId,
    currency: 'EUR',
    elements: [],
  }));
});

describe('buildSessionCdr', () => {
  it('sends the net as excl_vat and the amount charged as incl_vat to a 2.2.1 partner', async () => {
    primeGenerate('2.2.1');
    const cdr = await generateCdr('ses_1', 'opr_1');
    expect(cdr?.total_cost).toEqual({ excl_vat: 4, incl_vat: 4.76 });
    // The engine splits time by the charging and idle minutes of each part.
    expect(mocks.ocpiCdrCost).toHaveBeenCalledWith(SESSION, [
      { segment: null, chargingMinutes: 45, idleMinutes: 15 },
    ]);
    // ocpi_cdrs.total_cost holds the amount excluding tax.
    expect(inserted[0]).toMatchObject({ totalCost: '4', currency: 'EUR' });
  });

  it('sends a 2.3.0 Price to a 2.3.0 partner', async () => {
    primeGenerate('2.3.0');
    const cdr = await generateCdr('ses_1', 'opr_1');
    expect(cdr?.total_cost).toEqual({
      before_taxes: 4,
      taxes: [{ name: 'VAT', percentage: 19, amount: 0.76 }],
    });
    expect(inserted[0]).toMatchObject({ totalCost: '4' });
  });

  it('names the Session by the id stored on the CPO session link', async () => {
    primeGenerate('2.2.1');
    const cdr = await generateCdr('ses_1', 'opr_1', 'tx-legacy-1');
    expect(cdr?.session_id).toBe('tx-legacy-1');
  });

  it('uses the published location id and the partner token', async () => {
    primeGenerate('2.2.1');
    const cdr = await generateCdr('ses_1', 'opr_1');
    expect(cdr?.cdr_location.id).toBe('LOC-1');
    expect(cdr?.cdr_token).toMatchObject({ uid: 'TOKEN-1', country_code: 'NL', party_id: 'MSP' });
  });

  it('embeds the session tariff snapshot under the id of the mapping covering it', async () => {
    primeGenerate('2.3.0');
    const mapping = { id: 1, ocpiTariffId: 'T-1', tariffId: null, pricingGroupId: 'pgr_1' };
    mocks.sessionTariffMapping.mockResolvedValue(mapping);
    const cdr = await generateCdr('ses_1', 'opr_1');
    expect(mocks.sessionTariffMapping).toHaveBeenCalledWith('opr_1', 'trf_1');
    // The prices the session was billed at, not the tariff's current ones (B19).
    expect(mocks.renderSnapshotTariff).toHaveBeenCalledWith(
      {
        prices: PRICES,
        ocpiTariffId: 'T-1',
        currency: 'EUR',
        taxBasis: null,
        lastUpdated: startedAt,
      },
      '2.3.0',
    );
    expect(cdr?.tariffs).toEqual([{ id: 'T-1', currency: 'EUR', elements: [] }]);
    // Charging, then the 10 grace minutes and the 5 billed idle minutes (B16, B17).
    expect(cdr?.charging_periods).toEqual([
      {
        start_date_time: '2026-09-01T10:00:00.000Z',
        tariff_id: 'T-1',
        dimensions: [
          { type: 'ENERGY', volume: 10 },
          { type: 'TIME', volume: 0.75 },
        ],
      },
      {
        start_date_time: '2026-09-01T10:45:00.000Z',
        tariff_id: 'T-1',
        dimensions: [{ type: 'PARKING_TIME', volume: 0.1667 }],
      },
      {
        start_date_time: '2026-09-01T10:55:00.000Z',
        tariff_id: 'T-1',
        dimensions: [{ type: 'PARKING_TIME', volume: 0.0833 }],
      },
    ]);
  });

  it('embeds each segment tariff of a split session, distinct snapshots under distinct ids', async () => {
    primeGenerate('2.2.1');
    const mapping = { id: 1, ocpiTariffId: 'GRP', tariffId: null, pricingGroupId: 'pgr_1' };
    mocks.sessionTariffMapping.mockResolvedValue(mapping);
    const segment = (n: number, id: string, kwh: string, at: Date) => ({
      segment: n,
      tariffId: id,
      prices: { ...PRICES, id, pricePerKwh: kwh },
      period: {
        startedAt: at,
        kwh: 5,
        chargingMinutes: 30,
        idleMinutes: 0,
        billableIdleMinutes: 0,
      },
    });
    mocks.sessionCdrParts.mockResolvedValue([
      segment(1, 'trf_day', '0.40', startedAt),
      segment(2, 'trf_night', '0.20', new Date('2026-09-01T10:30:00Z')),
    ]);
    const cdr = await generateCdr('ses_1', 'opr_1');
    expect(cdr?.tariffs?.map((t) => t.id)).toEqual(['GRP', 'GRP-2']);
    expect(cdr?.charging_periods.map((p) => p.tariff_id)).toEqual(['GRP', 'GRP-2']);
    expect(mocks.ocpiCdrCost).toHaveBeenCalledWith(SESSION, [
      { segment: 1, chargingMinutes: 30, idleMinutes: 0 },
      { segment: 2, chargingMinutes: 30, idleMinutes: 0 },
    ]);
  });

  it('embeds no tariff when no mapping publishes the session tariff to the partner', async () => {
    primeGenerate('2.2.1');
    const cdr = await generateCdr('ses_1', 'opr_1');
    expect(cdr).not.toHaveProperty('tariffs');
  });
});

describe('issueSessionCdr', () => {
  it('stores one CDR for a completed session of a partner token', async () => {
    mocks.cpoSessionLink.mockResolvedValue(LINK);
    // session, existing CDR (none), partner version, link lock, existing in tx (none)
    selectResults = [[SESSION], [], [{ version: '2.2.1' }], [{ id: 7 }], []];
    const result = await issueSessionCdr('ses_1');
    expect(result.status).toBe('created');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      partnerId: 'opr_1',
      chargingSessionId: 'ses_1',
      isCredit: false,
      pushStatus: 'pending',
    });
    expect(mocks.notifyRoamingCdrChanged).toHaveBeenCalled();
  });

  it('returns the stored CDR instead of issuing a second one', async () => {
    mocks.cpoSessionLink.mockResolvedValue(LINK);
    selectResults = [[SESSION], [{ ocpiCdrId: 'cdr-1' }]];
    expect(await issueSessionCdr('ses_1')).toEqual({ status: 'existing', cdrId: 'cdr-1' });
    expect(inserted).toHaveLength(0);
  });

  it('returns the CDR another run stored while this one built it', async () => {
    mocks.cpoSessionLink.mockResolvedValue(LINK);
    selectResults = [[SESSION], [], [{ version: '2.2.1' }], [{ id: 7 }], [{ ocpiCdrId: 'cdr-9' }]];
    expect(await issueSessionCdr('ses_1')).toEqual({ status: 'existing', cdrId: 'cdr-9' });
    expect(inserted).toHaveLength(0);
    expect(mocks.notifyRoamingCdrChanged).not.toHaveBeenCalled();
  });

  it.each(['faulted', 'failed', 'invalid', 'active'])(
    'issues no CDR for a %s session (OCPI INVALID is not billed)',
    async (status) => {
      selectResults = [[{ ...SESSION, status }]];
      expect(await issueSessionCdr('ses_1')).toEqual({ status: 'not_billable' });
      expect(mocks.cpoSessionLink).not.toHaveBeenCalled();
    },
  );

  it('issues no CDR for a session no partner token started', async () => {
    mocks.cpoSessionLink.mockResolvedValue(null);
    selectResults = [[SESSION]];
    expect(await issueSessionCdr('ses_1')).toEqual({ status: 'not_roaming' });
  });

  it('reports an unknown session', async () => {
    selectResults = [[]];
    expect(await issueSessionCdr('ses_x')).toEqual({ status: 'not_found' });
  });
});

describe('pushCdr', () => {
  const ROW = {
    id: 1,
    ocpiCdrId: 'cdr-1',
    partnerId: 'opr_1',
    pushStatus: 'pending',
    cdrData: { id: 'cdr-1' },
  };

  it('POSTs the stored CDR and marks it sent', async () => {
    mocks.getOutboundToken.mockResolvedValue('token');
    mocks.post.mockResolvedValue({ status_code: 1000, status_message: 'OK' });
    selectResults = [
      [ROW],
      [{ url: 'https://emsp/cdrs' }],
      [{ countryCode: 'NL', partyId: 'MSP' }],
    ];
    expect(await pushCdr('cdr-1')).toBe('sent');
    expect(mocks.post).toHaveBeenCalledWith('https://emsp/cdrs', { id: 'cdr-1' });
    expect(updates[0]).toMatchObject({ pushStatus: 'sent' });
  });

  it('does not send a CDR twice', async () => {
    selectResults = [[{ ...ROW, pushStatus: 'sent' }]];
    expect(await pushCdr('cdr-1')).toBe('already_sent');
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('leaves the CDR pending for a partner without a CDRs receiver', async () => {
    selectResults = [[ROW], []];
    expect(await pushCdr('cdr-1')).toBe('no_receiver');
    expect(updates).toHaveLength(0);
  });

  it('marks the CDR failed when the partner rejects it', async () => {
    mocks.getOutboundToken.mockResolvedValue('token');
    mocks.post.mockResolvedValue({ status_code: 3000, status_message: 'down' });
    selectResults = [
      [ROW],
      [{ url: 'https://emsp/cdrs' }],
      [{ countryCode: 'NL', partyId: 'MSP' }],
    ];
    expect(await pushCdr('cdr-1')).toBe('failed');
    expect(updates[0]).toMatchObject({ pushStatus: 'failed' });
  });
});

describe('generateCreditCdr', () => {
  it('stores the credit through the shared builder and notifies the CSMS', async () => {
    const cdrData = { id: 'cdr-2', credit: true, total_cost: { excl_vat: -4 } };
    mocks.createCreditCdr.mockResolvedValue({ status: 'created', cdrId: 'cdr-2', cdrData });
    expect(await generateCreditCdr('cdr-1', 'wrong tariff')).toEqual(cdrData);
    expect(mocks.createCreditCdr).toHaveBeenCalledWith('cdr-1', 'wrong tariff');
    expect(mocks.notifyRoamingCdrChanged).toHaveBeenCalled();
  });

  it('returns the existing credit CDR without a second notification', async () => {
    const cdrData = { id: 'cdr-2', credit: true };
    mocks.createCreditCdr.mockResolvedValue({ status: 'existing', cdrId: 'cdr-2', cdrData });
    expect(await generateCreditCdr('cdr-1', 'again')).toEqual(cdrData);
    expect(mocks.notifyRoamingCdrChanged).not.toHaveBeenCalled();
  });

  it('returns null when the CDR cannot be credited', async () => {
    for (const status of ['not_found', 'is_credit', 'invalid_cdr']) {
      mocks.createCreditCdr.mockResolvedValue({ status });
      expect(await generateCreditCdr('cdr-1', 'x')).toBeNull();
    }
  });
});
