// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { OcpiPartnerInfo } from '../middleware/ocpi-auth.js';

// Each awaited select chain resolves to the next queued result. Updates and
// inserts record what the route wrote.
const h = vi.hoisted(() => ({
  selects: [] as unknown[][],
  updates: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[],
  partner: undefined as OcpiPartnerInfo | undefined,
}));

function makeSelectChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(h.selects.shift() ?? []).then(resolve);
  return chain;
}

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: {
    select: vi.fn(() => makeSelectChain()),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        h.updates.push(values);
        return { where: () => Promise.resolve(undefined) };
      },
    })),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        h.inserts.push(values);
        return Promise.resolve(undefined);
      },
    })),
  },
}));
vi.mock('../middleware/ocpi-auth.js', () => ({
  ocpiAuthenticate: (request: { ocpiPartner?: OcpiPartnerInfo }) => {
    if (h.partner != null) request.ocpiPartner = h.partner;
    return Promise.resolve();
  },
}));

const { emspLocationRoutes } = await import('../routes/emsp/locations.js');

const PARTNER: OcpiPartnerInfo = {
  partnerId: 'opr_000000000001',
  partnerName: 'Partner CPO',
  countryCode: 'DE',
  partyId: 'ABC',
  allowPrivateNetwork: false,
  tokenId: 1,
};

function connector(id: string): Record<string, unknown> {
  return {
    id,
    standard: 'IEC_62196_T2',
    format: 'SOCKET',
    power_type: 'AC_3_PHASE',
    max_voltage: 400,
    max_amperage: 32,
    last_updated: '2026-09-01T00:00:00Z',
  };
}

function locationData(): Record<string, unknown> {
  return {
    country_code: 'DE',
    party_id: 'ABC',
    id: 'LOC1',
    publish: true,
    name: 'Old Name',
    address: '1 Main St',
    city: 'Berlin',
    country: 'DEU',
    coordinates: { latitude: '52.5', longitude: '13.4' },
    time_zone: 'Europe/Berlin',
    evses: [
      {
        uid: 'EVSE1',
        status: 'AVAILABLE',
        connectors: [connector('1'), connector('2')],
        last_updated: '2026-09-01T00:00:00Z',
      },
    ],
    last_updated: '2026-09-01T00:00:00Z',
  };
}

function row(data: Record<string, unknown> = locationData()): Record<string, unknown> {
  return { id: 42, locationData: data };
}

type Body = { status_code: number; status_message: string; data: unknown };

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  emspLocationRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  h.selects = [];
  h.updates = [];
  h.inserts = [];
  h.partner = { ...PARTNER };
});

const BASE = '/ocpi/2.2.1/emsp/locations/DE/ABC/LOC1';

describe('GET emsp locations', () => {
  it.each(['2.2.1', '2.3.0'])('returns the stored location for version %s', async (v) => {
    h.selects = [[row()]];
    const res = await app.inject({ method: 'GET', url: `/ocpi/${v}/emsp/locations/DE/ABC/LOC1` });
    expect(res.statusCode).toBe(200);
    const body = res.json<Body>();
    expect(body.status_code).toBe(1000);
    expect(body.data).toMatchObject({ id: 'LOC1', name: 'Old Name' });
  });

  it('returns 401 when the partner is not registered', async () => {
    h.partner = { ...PARTNER, partnerId: null };
    const res = await app.inject({ method: 'GET', url: BASE });
    expect(res.statusCode).toBe(401);
    expect(res.json<Body>()).toMatchObject({ status_code: 2000, data: null });
  });

  it('returns 401 for all GET levels when no partner is attached', async () => {
    h.partner = undefined;
    for (const url of [BASE, `${BASE}/EVSE1`, `${BASE}/EVSE1/1`]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
      expect(res.json<Body>().status_message).toBe('Not authenticated');
    }
  });

  it('returns 2003 when the location is unknown', async () => {
    h.selects = [[]];
    const res = await app.inject({ method: 'GET', url: BASE });
    expect(res.statusCode).toBe(404);
    expect(res.json<Body>()).toMatchObject({
      status_code: 2003,
      status_message: 'Location not found',
    });
  });

  it('returns one EVSE by uid', async () => {
    h.selects = [[row()]];
    const res = await app.inject({ method: 'GET', url: `${BASE}/EVSE1` });
    expect(res.statusCode).toBe(200);
    expect(res.json<Body>().data).toMatchObject({ uid: 'EVSE1', status: 'AVAILABLE' });
  });

  it('returns 404 for an unknown location or EVSE at EVSE level', async () => {
    h.selects = [[]];
    let res = await app.inject({ method: 'GET', url: `${BASE}/EVSE1` });
    expect(res.statusCode).toBe(404);
    expect(res.json<Body>().status_message).toBe('Location not found');

    h.selects = [[row()]];
    res = await app.inject({ method: 'GET', url: `${BASE}/NOPE` });
    expect(res.statusCode).toBe(404);
    expect(res.json<Body>()).toMatchObject({ status_code: 2003, status_message: 'EVSE not found' });
  });

  it('returns 404 for a location without any EVSEs', async () => {
    const data = locationData();
    delete data['evses'];
    h.selects = [[row(data)]];
    const res = await app.inject({ method: 'GET', url: `${BASE}/EVSE1` });
    expect(res.statusCode).toBe(404);
    expect(res.json<Body>().status_message).toBe('EVSE not found');
  });

  it('returns one connector by id', async () => {
    h.selects = [[row()]];
    const res = await app.inject({ method: 'GET', url: `${BASE}/EVSE1/2` });
    expect(res.statusCode).toBe(200);
    expect(res.json<Body>()).toMatchObject({ status_code: 1000, data: { id: '2' } });
  });

  it('returns 404 at connector level for each missing level', async () => {
    h.selects = [[]];
    let res = await app.inject({ method: 'GET', url: `${BASE}/EVSE1/1` });
    expect(res.json<Body>().status_message).toBe('Location not found');

    h.selects = [[row()]];
    res = await app.inject({ method: 'GET', url: `${BASE}/NOPE/1` });
    expect(res.json<Body>().status_message).toBe('EVSE not found');

    h.selects = [[row()]];
    res = await app.inject({ method: 'GET', url: `${BASE}/EVSE1/9` });
    expect(res.statusCode).toBe(404);
    expect(res.json<Body>()).toMatchObject({
      status_code: 2003,
      status_message: 'Connector not found',
    });
  });
});

describe('PUT emsp location', () => {
  it('inserts a new location with derived columns', async () => {
    h.selects = [[]];
    const payload = locationData();
    const res = await app.inject({ method: 'PUT', url: BASE, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json<Body>()).toMatchObject({ status_code: 1000, data: null });
    expect(h.updates).toHaveLength(0);
    expect(h.inserts).toEqual([
      {
        partnerId: PARTNER.partnerId,
        countryCode: 'DE',
        partyId: 'ABC',
        locationId: 'LOC1',
        name: 'Old Name',
        latitude: '52.5',
        longitude: '13.4',
        evseCount: '1',
        locationData: payload,
      },
    ]);
  });

  it('updates an existing location and stores a null name and zero EVSEs', async () => {
    h.selects = [[{ id: 7 }]];
    const payload = locationData();
    delete payload['name'];
    delete payload['evses'];
    const res = await app.inject({ method: 'PUT', url: BASE, payload });
    expect(res.statusCode).toBe(200);
    expect(h.inserts).toHaveLength(0);
    expect(h.updates[0]).toMatchObject({
      name: null,
      latitude: '52.5',
      longitude: '13.4',
      evseCount: '0',
      locationData: payload,
    });
    expect(h.updates[0]?.['updatedAt']).toBeInstanceOf(Date);
  });

  it('rejects a namespace that does not match the credentials', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/ocpi/2.2.1/emsp/locations/NL/XYZ/LOC1',
      payload: locationData(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<Body>().status_message).toBe('Cannot PUT location for another partner');
    expect(h.inserts).toHaveLength(0);
  });

  it('rejects a partner without a confirmed namespace', async () => {
    h.partner = { ...PARTNER, countryCode: null };
    const res = await app.inject({ method: 'PUT', url: BASE, payload: locationData() });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a body that is not an object', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: BASE,
      headers: { 'content-type': 'application/json' },
      payload: '"text"',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>()).toMatchObject({
      status_code: 2001,
      status_message: 'Invalid location object',
    });
  });

  it('rejects a location without coordinates', async () => {
    const payload = locationData();
    delete payload['coordinates'];
    const res = await app.inject({ method: 'PUT', url: BASE, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>().status_message).toBe('Location coordinates are required');
  });

  it('returns 401 for every write level without a registered partner', async () => {
    h.partner = { ...PARTNER, partnerId: null };
    for (const method of ['PUT', 'PATCH'] as const) {
      for (const url of [BASE, `${BASE}/EVSE1`, `${BASE}/EVSE1/1`]) {
        const res = await app.inject({ method, url, payload: {} });
        expect(res.statusCode).toBe(401);
      }
    }
  });
});

describe('PUT emsp EVSE', () => {
  it('replaces an existing EVSE and keeps the count', async () => {
    h.selects = [[row()]];
    const evse = { uid: 'EVSE1', status: 'CHARGING', connectors: [connector('1')] };
    const res = await app.inject({ method: 'PUT', url: `${BASE}/EVSE1`, payload: evse });
    expect(res.statusCode).toBe(200);
    const update = h.updates[0] as { evseCount: string; locationData: { evses: unknown[] } };
    expect(update.evseCount).toBe('1');
    expect(update.locationData.evses).toEqual([evse]);
  });

  it('appends a new EVSE, also when the location had none', async () => {
    const data = locationData();
    delete data['evses'];
    h.selects = [[row(data)]];
    const evse = { uid: 'EVSE2', status: 'AVAILABLE', connectors: [] };
    const res = await app.inject({ method: 'PUT', url: `${BASE}/EVSE2`, payload: evse });
    expect(res.statusCode).toBe(200);
    const update = h.updates[0] as { evseCount: string; locationData: { evses: unknown[] } };
    expect(update.evseCount).toBe('1');
    expect(update.locationData.evses).toEqual([evse]);

    h.selects = [[row()]];
    await app.inject({ method: 'PUT', url: `${BASE}/EVSE2`, payload: evse });
    const second = h.updates[1] as {
      evseCount: string;
      locationData: { evses: { uid: string }[] };
    };
    expect(second.evseCount).toBe('2');
    expect(second.locationData.evses.map((e) => e.uid)).toEqual(['EVSE1', 'EVSE2']);
  });

  it('rejects a foreign namespace, a bad body and an unknown location', async () => {
    let res = await app.inject({
      method: 'PUT',
      url: '/ocpi/2.3.0/emsp/locations/NL/ABC/LOC1/EVSE1',
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<Body>().status_message).toBe('Cannot PUT EVSE for another partner');

    res = await app.inject({
      method: 'PUT',
      url: `${BASE}/EVSE1`,
      headers: { 'content-type': 'application/json' },
      payload: '5',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>().status_message).toBe('Invalid EVSE object');

    h.selects = [[]];
    res = await app.inject({ method: 'PUT', url: `${BASE}/EVSE1`, payload: { uid: 'EVSE1' } });
    expect(res.statusCode).toBe(404);
    expect(res.json<Body>().status_code).toBe(2003);
    expect(h.updates).toHaveLength(0);
  });
});

describe('PUT emsp connector', () => {
  it('replaces an existing connector', async () => {
    h.selects = [[row()]];
    const conn = { ...connector('2'), max_amperage: 16 };
    const res = await app.inject({ method: 'PUT', url: `${BASE}/EVSE1/2`, payload: conn });
    expect(res.statusCode).toBe(200);
    const update = h.updates[0] as {
      locationData: { evses: { connectors: Record<string, unknown>[] }[] };
    };
    const conns = update.locationData.evses[0]?.connectors ?? [];
    expect(conns).toHaveLength(2);
    expect(conns[1]).toEqual(conn);
  });

  it('appends a new connector', async () => {
    h.selects = [[row()]];
    const res = await app.inject({
      method: 'PUT',
      url: `${BASE}/EVSE1/3`,
      payload: connector('3'),
    });
    expect(res.statusCode).toBe(200);
    const update = h.updates[0] as {
      locationData: { evses: { connectors: { id: string }[] }[] };
    };
    expect(update.locationData.evses[0]?.connectors.map((c) => c.id)).toEqual(['1', '2', '3']);
  });

  it('rejects a foreign namespace, a bad body, an unknown location and an unknown EVSE', async () => {
    let res = await app.inject({
      method: 'PUT',
      url: '/ocpi/2.2.1/emsp/locations/DE/XYZ/LOC1/EVSE1/1',
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<Body>().status_message).toBe('Cannot PUT connector for another partner');

    res = await app.inject({
      method: 'PUT',
      url: `${BASE}/EVSE1/1`,
      headers: { 'content-type': 'application/json' },
      payload: 'null',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>().status_message).toBe('Invalid connector object');

    h.selects = [[]];
    res = await app.inject({ method: 'PUT', url: `${BASE}/EVSE1/1`, payload: connector('1') });
    expect(res.json<Body>().status_message).toBe('Location not found');

    h.selects = [[row()]];
    res = await app.inject({ method: 'PUT', url: `${BASE}/NOPE/1`, payload: connector('1') });
    expect(res.statusCode).toBe(404);
    expect(res.json<Body>().status_message).toBe('EVSE not found');
    expect(h.updates).toHaveLength(0);
  });
});

describe('PATCH emsp location', () => {
  it('merges fields and updates the derived columns that changed', async () => {
    h.selects = [[row()]];
    const patch = {
      name: 'New Name',
      coordinates: { latitude: '48.1', longitude: '11.5' },
      evses: [],
    };
    const res = await app.inject({ method: 'PATCH', url: BASE, payload: patch });
    expect(res.statusCode).toBe(200);
    const update = h.updates[0] as Record<string, unknown>;
    expect(update).toMatchObject({
      name: 'New Name',
      latitude: '48.1',
      longitude: '11.5',
      evseCount: '0',
      locationData: { id: 'LOC1', city: 'Berlin', name: 'New Name', evses: [] },
    });
  });

  it('leaves derived columns alone when the patch does not touch them', async () => {
    h.selects = [[row()]];
    const res = await app.inject({
      method: 'PATCH',
      url: BASE,
      payload: { city: 'Hamburg', name: 5, coordinates: {} },
    });
    expect(res.statusCode).toBe(200);
    const update = h.updates[0] as Record<string, unknown>;
    expect(update).not.toHaveProperty('name');
    expect(update).not.toHaveProperty('latitude');
    expect(update).not.toHaveProperty('longitude');
    expect(update).not.toHaveProperty('evseCount');
    expect(update['locationData']).toMatchObject({ city: 'Hamburg', name: 5 });
  });

  it('rejects a foreign namespace, a bad body and an unknown location', async () => {
    let res = await app.inject({
      method: 'PATCH',
      url: '/ocpi/2.2.1/emsp/locations/NL/ABC/LOC1',
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<Body>().status_message).toBe('Cannot PATCH location for another partner');

    res = await app.inject({
      method: 'PATCH',
      url: BASE,
      headers: { 'content-type': 'application/json' },
      payload: 'true',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>().status_message).toBe('PATCH body must be a JSON object');

    h.selects = [[]];
    res = await app.inject({ method: 'PATCH', url: BASE, payload: { name: 'x' } });
    expect(res.statusCode).toBe(404);
    expect(h.updates).toHaveLength(0);
  });
});

describe('PATCH emsp EVSE', () => {
  it('merges the patch into the EVSE', async () => {
    h.selects = [[row()]];
    const res = await app.inject({
      method: 'PATCH',
      url: `${BASE}/EVSE1`,
      payload: { status: 'CHARGING' },
    });
    expect(res.statusCode).toBe(200);
    const update = h.updates[0] as {
      locationData: { evses: { uid: string; status: string; connectors: unknown[] }[] };
    };
    expect(update.locationData.evses[0]).toMatchObject({ uid: 'EVSE1', status: 'CHARGING' });
    expect(update.locationData.evses[0]?.connectors).toHaveLength(2);
  });

  it('returns 404 for an unknown EVSE, also when the location has none', async () => {
    h.selects = [[row()]];
    let res = await app.inject({ method: 'PATCH', url: `${BASE}/NOPE`, payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json<Body>().status_message).toBe('EVSE not found');

    const data = locationData();
    delete data['evses'];
    h.selects = [[row(data)]];
    res = await app.inject({ method: 'PATCH', url: `${BASE}/EVSE1`, payload: {} });
    expect(res.json<Body>().status_message).toBe('EVSE not found');
    expect(h.updates).toHaveLength(0);
  });

  it('rejects a foreign namespace, a bad body and an unknown location', async () => {
    let res = await app.inject({
      method: 'PATCH',
      url: '/ocpi/2.2.1/emsp/locations/NL/ABC/LOC1/EVSE1',
      payload: {},
    });
    expect(res.json<Body>().status_message).toBe('Cannot PATCH EVSE for another partner');

    res = await app.inject({
      method: 'PATCH',
      url: `${BASE}/EVSE1`,
      headers: { 'content-type': 'application/json' },
      payload: '1',
    });
    expect(res.statusCode).toBe(400);

    h.selects = [[]];
    res = await app.inject({ method: 'PATCH', url: `${BASE}/EVSE1`, payload: {} });
    expect(res.json<Body>().status_message).toBe('Location not found');
  });
});

describe('PATCH emsp connector', () => {
  it('merges the patch into the connector', async () => {
    h.selects = [[row()]];
    const res = await app.inject({
      method: 'PATCH',
      url: `${BASE}/EVSE1/1`,
      payload: { max_amperage: 16 },
    });
    expect(res.statusCode).toBe(200);
    const update = h.updates[0] as {
      locationData: { evses: { connectors: Record<string, unknown>[] }[] };
    };
    expect(update.locationData.evses[0]?.connectors[0]).toMatchObject({
      id: '1',
      max_amperage: 16,
      max_voltage: 400,
    });
  });

  it('returns 404 for each missing level', async () => {
    h.selects = [[]];
    let res = await app.inject({ method: 'PATCH', url: `${BASE}/EVSE1/1`, payload: {} });
    expect(res.json<Body>().status_message).toBe('Location not found');

    h.selects = [[row()]];
    res = await app.inject({ method: 'PATCH', url: `${BASE}/NOPE/1`, payload: {} });
    expect(res.json<Body>().status_message).toBe('EVSE not found');

    h.selects = [[row()]];
    res = await app.inject({ method: 'PATCH', url: `${BASE}/EVSE1/9`, payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json<Body>().status_message).toBe('Connector not found');
    expect(h.updates).toHaveLength(0);
  });

  it('rejects a foreign namespace and a bad body', async () => {
    let res = await app.inject({
      method: 'PATCH',
      url: '/ocpi/2.2.1/emsp/locations/NL/ABC/LOC1/EVSE1/1',
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<Body>().status_message).toBe('Cannot PATCH connector for another partner');

    res = await app.inject({
      method: 'PATCH',
      url: `${BASE}/EVSE1/1`,
      headers: { 'content-type': 'application/json' },
      payload: '"x"',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>().status_code).toBe(2001);
  });
});
