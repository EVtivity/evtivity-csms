// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as argon2 from 'argon2';
import { decryptString, encryptString } from '@evtivity/lib';
import { ocpiCredentialsTokens, ocpiPartnerEndpoints, ocpiPartners } from '@evtivity/database';

// Every db call is recorded; each awaited chain resolves to the next queued result.
interface DbOp {
  op: 'select' | 'insert' | 'update' | 'delete';
  table: unknown;
  set?: Record<string, unknown>;
  values?: unknown;
  returning?: boolean;
}
let dbResults: unknown[][] = [];
let ops: DbOp[] = [];
function makeChain(entry: DbOp): Record<string, unknown> {
  ops.push(entry);
  const chain: Record<string, unknown> = {};
  for (const m of ['where', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['from'] = vi.fn((table: unknown) => {
    entry.table = table;
    return chain;
  });
  chain['set'] = vi.fn((v: Record<string, unknown>) => {
    entry.set = v;
    return chain;
  });
  chain['values'] = vi.fn((v: unknown) => {
    entry.values = v;
    return chain;
  });
  chain['returning'] = vi.fn(() => {
    entry.returning = true;
    return chain;
  });
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(dbResults.shift() ?? []).then(resolve);
  return chain;
}

const { clientGet, clientPost, clientOptions } = vi.hoisted(() => ({
  clientGet: vi.fn(),
  clientPost: vi.fn(),
  clientOptions: [] as unknown[],
}));

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: {
    select: vi.fn(() => makeChain({ op: 'select', table: null })),
    insert: vi.fn((table: unknown) => makeChain({ op: 'insert', table })),
    update: vi.fn((table: unknown) => makeChain({ op: 'update', table })),
    delete: vi.fn((table: unknown) => makeChain({ op: 'delete', table })),
  },
}));

vi.mock('../lib/ocpi-client.js', () => ({
  OcpiClient: class {
    constructor(options: unknown) {
      clientOptions.push(options);
    }
    get = clientGet;
    post = clientPost;
  },
}));

const svc = await import('../services/credentials.service.js');

const KEY = 'test-encryption-key-32chars!!!!!';
const BASE = 'http://localhost:7104';
const VERSIONS_URL = 'https://partner.example.com/ocpi/versions';

const PARTNER_CREDENTIALS = {
  token: 'partner-token-B-0123456789',
  url: VERSIONS_URL,
  roles: [
    {
      role: 'EMSP' as const,
      party_id: 'ABC',
      country_code: 'NL',
      business_details: { name: 'Partner NL' },
    },
  ],
};

const ENDPOINTS = [
  { identifier: 'credentials', role: 'RECEIVER', url: 'https://partner.example.com/creds' },
  { identifier: 'tokens', role: 'SENDER', url: 'https://partner.example.com/tokens' },
];

function envelope<T>(data: T): { data: T; status_code: number } {
  return { data, status_code: 1000 };
}

// Partner /versions and version detail responses.
function partnerOffers(
  versions: { version: string; url: string }[],
  endpoints: unknown = ENDPOINTS,
): void {
  clientGet.mockImplementation((url: string) => {
    if (url === VERSIONS_URL) return Promise.resolve(envelope(versions));
    const v = versions.find((x) => x.url === url);
    if (v != null) return Promise.resolve(envelope({ version: v.version, endpoints }));
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

const BOTH = [
  { version: '2.2.1', url: 'https://partner.example.com/ocpi/2.2.1' },
  { version: '2.3.0', url: 'https://partner.example.com/ocpi/2.3.0' },
];

beforeEach(() => {
  dbResults = [];
  ops = [];
  clientOptions.length = 0;
  clientGet.mockReset();
  clientPost.mockReset();
});

function opsOn(table: unknown, op: DbOp['op']): DbOp[] {
  return ops.filter((o) => o.table === table && o.op === op);
}

describe('buildOurCredentials', () => {
  it('returns CPO and EMSP roles with our party and versions URL', () => {
    const creds = svc.buildOurCredentials('tok');
    expect(creds.token).toBe('tok');
    expect(creds.url).toBe(`${BASE}/ocpi/versions`);
    expect(creds.roles.map((r) => r.role)).toEqual(['CPO', 'EMSP']);
    for (const role of creds.roles) {
      expect(role).toMatchObject({
        party_id: 'EVT',
        country_code: 'US',
        business_details: { name: 'EVtivity' },
      });
      expect(role.business_details.website).toBeUndefined();
    }
  });
});

describe('generateAndStoreToken', () => {
  it('stores an argon2 hash and the 8-char prefix of a 64-hex token', async () => {
    const token = await svc.generateAndStoreToken('opr_000000000001', 'issued');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const [insert] = opsOn(ocpiCredentialsTokens, 'insert');
    const values = insert?.values as Record<string, unknown>;
    expect(values).toMatchObject({
      partnerId: 'opr_000000000001',
      tokenPrefix: token.slice(0, 8),
      direction: 'issued',
      isActive: true,
    });
    expect(values['tokenHash']).not.toBe(token);
    await expect(argon2.verify(values['tokenHash'] as string, token)).resolves.toBe(true);
  });

  it('generates a different token each time', async () => {
    const a = await svc.generateAndStoreToken(null, 'issued');
    const b = await svc.generateAndStoreToken(null, 'issued');
    expect(a).not.toBe(b);
  });
});

describe('handleRegistration', () => {
  it('refuses a registration token another request already claimed', async () => {
    dbResults = [[]]; // claim UPDATE ... RETURNING returns no row
    const err = await svc.handleRegistration(PARTNER_CREDENTIALS, 9).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Registration token already used');
    expect((err as Error & { code: string }).code).toBe('TOKEN_ALREADY_USED');
    expect(clientGet).not.toHaveBeenCalled();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: 'update',
      table: ocpiCredentialsTokens,
      set: { isActive: false },
      returning: true,
    });
  });

  it('rejects credentials without roles', async () => {
    await expect(svc.handleRegistration({ ...PARTNER_CREDENTIALS, roles: [] }, 9)).rejects.toThrow(
      'No roles provided in credentials',
    );
    expect(ops).toHaveLength(0);
  });

  it('creates a new partner, stores endpoints and both tokens', async () => {
    partnerOffers(BOTH);
    dbResults = [
      [{ id: 9 }], // claim
      [], // existing partner lookup
      [{ id: 'opr_000000000042' }], // insert partner returning
    ];
    const result = await svc.handleRegistration(PARTNER_CREDENTIALS, 9, '2.3.0');

    // Version negotiation: preferred 2.3.0 is offered, so its detail URL is used.
    expect(clientGet.mock.calls.map((c) => c[0])).toEqual([
      VERSIONS_URL,
      'https://partner.example.com/ocpi/2.3.0',
    ]);
    expect(clientOptions[0]).toMatchObject({
      token: PARTNER_CREDENTIALS.token,
      fromCountryCode: 'US',
      fromPartyId: 'EVT',
      allowPrivateNetwork: false,
    });

    const [partnerInsert] = opsOn(ocpiPartners, 'insert');
    expect(partnerInsert?.values).toMatchObject({
      name: 'Partner NL',
      countryCode: 'NL',
      partyId: 'ABC',
      status: 'connected',
      version: '2.3.0',
      versionUrl: VERSIONS_URL,
      roles: PARTNER_CREDENTIALS.roles,
    });

    expect(opsOn(ocpiPartnerEndpoints, 'delete')).toHaveLength(1);
    const [endpointInsert] = opsOn(ocpiPartnerEndpoints, 'insert');
    expect(endpointInsert?.values).toEqual([
      {
        partnerId: 'opr_000000000042',
        module: 'credentials',
        interfaceRole: 'RECEIVER',
        url: 'https://partner.example.com/creds',
      },
      {
        partnerId: 'opr_000000000042',
        module: 'tokens',
        interfaceRole: 'SENDER',
        url: 'https://partner.example.com/tokens',
      },
    ]);

    const tokenInserts = opsOn(ocpiCredentialsTokens, 'insert').map(
      (o) => o.values as Record<string, unknown>,
    );
    expect(tokenInserts).toHaveLength(2);
    const received = tokenInserts.find((v) => v['direction'] === 'received');
    const issued = tokenInserts.find((v) => v['direction'] === 'issued');
    expect(received).toMatchObject({
      partnerId: 'opr_000000000042',
      tokenPrefix: 'partner-',
      isActive: true,
    });
    expect(decryptString(received?.['outboundTokenEnc'] as string, KEY)).toBe(
      PARTNER_CREDENTIALS.token,
    );
    await expect(
      argon2.verify(received?.['tokenHash'] as string, PARTNER_CREDENTIALS.token),
    ).resolves.toBe(true);

    // The returned token is the issued one, and it is stored hashed.
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(issued?.['tokenPrefix']).toBe(result.token.slice(0, 8));
    await expect(argon2.verify(issued?.['tokenHash'] as string, result.token)).resolves.toBe(true);
    expect(result.url).toBe(`${BASE}/ocpi/versions`);
    expect(result.roles.map((r) => r.role)).toEqual(['CPO', 'EMSP']);

    // Old received and issued tokens are deactivated before the new ones.
    const deactivations = opsOn(ocpiCredentialsTokens, 'update').filter(
      (o) => o.returning !== true,
    );
    expect(deactivations).toHaveLength(2);
    for (const d of deactivations) expect(d.set).toEqual({ isActive: false });
  });

  it('updates a pre-created partner and honors its private-network flag', async () => {
    partnerOffers([{ version: '2.2.1', url: 'https://partner.example.com/ocpi/2.2.1' }], []);
    dbResults = [[{ id: 9 }], [{ id: 'opr_000000000007', allowPrivateNetwork: true }]];
    await svc.handleRegistration(PARTNER_CREDENTIALS, 9, '2.3.0');

    // 2.3.0 not offered: falls back to 2.2.1.
    expect(clientGet).toHaveBeenLastCalledWith('https://partner.example.com/ocpi/2.2.1');
    expect(clientOptions[0]).toMatchObject({ allowPrivateNetwork: true });
    expect(opsOn(ocpiPartners, 'insert')).toHaveLength(0);
    const [partnerUpdate] = opsOn(ocpiPartners, 'update');
    expect(partnerUpdate?.set).toMatchObject({
      name: 'Partner NL',
      status: 'connected',
      version: '2.2.1',
      versionUrl: VERSIONS_URL,
    });
    // No endpoints offered: old ones deleted, nothing inserted.
    expect(opsOn(ocpiPartnerEndpoints, 'delete')).toHaveLength(1);
    expect(opsOn(ocpiPartnerEndpoints, 'insert')).toHaveLength(0);
  });

  it('fails when the partner insert returns no row', async () => {
    partnerOffers(BOTH);
    dbResults = [[{ id: 9 }], [], []];
    await expect(svc.handleRegistration(PARTNER_CREDENTIALS, 9)).rejects.toThrow(
      'Failed to create partner record',
    );
  });

  it('fails when the partner returns no versions', async () => {
    clientGet.mockResolvedValue(envelope([]));
    dbResults = [[{ id: 9 }], []];
    await expect(svc.handleRegistration(PARTNER_CREDENTIALS, 9)).rejects.toThrow(
      'Partner returned no versions',
    );
  });

  it('fails when the versions payload is not an array', async () => {
    clientGet.mockResolvedValue(envelope(null));
    dbResults = [[{ id: 9 }], []];
    await expect(svc.handleRegistration(PARTNER_CREDENTIALS, 9)).rejects.toThrow(
      'Partner returned no versions',
    );
  });

  it('fails when no offered version is supported', async () => {
    partnerOffers([{ version: '2.1.1', url: 'https://partner.example.com/ocpi/2.1.1' }]);
    dbResults = [[{ id: 9 }], []];
    await expect(svc.handleRegistration(PARTNER_CREDENTIALS, 9)).rejects.toThrow(
      'No compatible OCPI version found',
    );
  });

  it('fails when the version detail has no endpoints array', async () => {
    partnerOffers(BOTH, null);
    dbResults = [[{ id: 9 }], []];
    await expect(svc.handleRegistration(PARTNER_CREDENTIALS, 9)).rejects.toThrow(
      'Partner returned invalid version detail',
    );
  });
});

describe('handleCredentialUpdate', () => {
  it('rejects credentials without roles', async () => {
    await expect(
      svc.handleCredentialUpdate({ ...PARTNER_CREDENTIALS, roles: [] }, 'opr_000000000001'),
    ).rejects.toThrow('No roles provided in credentials');
  });

  it('refreshes the partner, endpoints and both tokens', async () => {
    partnerOffers(BOTH);
    dbResults = [[{ allowPrivateNetwork: true }]];
    const result = await svc.handleCredentialUpdate(PARTNER_CREDENTIALS, 'opr_000000000001');

    // Default preferred version is 2.2.1.
    expect(clientGet).toHaveBeenLastCalledWith('https://partner.example.com/ocpi/2.2.1');
    expect(clientOptions[0]).toMatchObject({ allowPrivateNetwork: true });
    const [partnerUpdate] = opsOn(ocpiPartners, 'update');
    expect(partnerUpdate?.set).toMatchObject({
      name: 'Partner NL',
      version: '2.2.1',
      versionUrl: VERSIONS_URL,
      roles: PARTNER_CREDENTIALS.roles,
    });
    expect(opsOn(ocpiPartnerEndpoints, 'insert')[0]?.values).toHaveLength(2);
    const inserts = opsOn(ocpiCredentialsTokens, 'insert').map(
      (o) => o.values as Record<string, unknown>,
    );
    expect(inserts.map((v) => v['direction'])).toEqual(['received', 'issued']);
    expect(decryptString(inserts[0]?.['outboundTokenEnc'] as string, KEY)).toBe(
      PARTNER_CREDENTIALS.token,
    );
    expect(inserts[1]?.['tokenPrefix']).toBe(result.token.slice(0, 8));
  });

  it('defaults to no private network when the partner row is missing', async () => {
    partnerOffers(BOTH, []);
    dbResults = [[]];
    await svc.handleCredentialUpdate(PARTNER_CREDENTIALS, 'opr_000000000001', '2.3.0');
    expect(clientOptions[0]).toMatchObject({ allowPrivateNetwork: false });
    expect(clientGet).toHaveBeenLastCalledWith('https://partner.example.com/ocpi/2.3.0');
    expect(opsOn(ocpiPartnerEndpoints, 'insert')).toHaveLength(0);
  });
});

describe('handleUnregister', () => {
  it('disconnects the partner and deactivates all its tokens', async () => {
    await svc.handleUnregister('opr_000000000001');
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ op: 'update', table: ocpiPartners });
    expect(ops[0]?.set).toMatchObject({ status: 'disconnected' });
    expect(ops[0]?.set?.['updatedAt']).toBeInstanceOf(Date);
    expect(ops[1]).toMatchObject({
      op: 'update',
      table: ocpiCredentialsTokens,
      set: { isActive: false },
    });
  });
});

describe('initiateRegistration', () => {
  const PARTNER_ROW = {
    id: 'opr_000000000001',
    countryCode: 'NL',
    partyId: 'ABC',
    versionUrl: VERSIONS_URL,
    allowPrivateNetwork: false,
    partnerRegistrationTokenEnc: encryptString('token-C-registration', KEY),
  };

  it('fails for an unknown partner', async () => {
    dbResults = [[]];
    await expect(svc.initiateRegistration('opr_000000000001')).rejects.toThrow('Partner not found');
  });

  it.each([null, ''])('fails without a versions URL (%s)', async (versionUrl) => {
    dbResults = [[{ ...PARTNER_ROW, versionUrl }]];
    await expect(svc.initiateRegistration('opr_000000000001')).rejects.toThrow(
      'Partner versionUrl not configured',
    );
  });

  it('fails without a stored registration token', async () => {
    dbResults = [[{ ...PARTNER_ROW, partnerRegistrationTokenEnc: null }]];
    await expect(svc.initiateRegistration('opr_000000000001')).rejects.toThrow(
      /Partner registration token not configured/,
    );
  });

  it('fails when the partner has no credentials endpoint', async () => {
    partnerOffers(BOTH, [ENDPOINTS[1]]);
    dbResults = [[PARTNER_ROW]];
    await expect(svc.initiateRegistration('opr_000000000001')).rejects.toThrow(
      'Partner does not expose a credentials endpoint',
    );
    expect(clientOptions[0]).toMatchObject({ token: 'token-C-registration' });
    expect(clientPost).not.toHaveBeenCalled();
  });

  it('fails when the partner returns no credentials', async () => {
    partnerOffers(BOTH);
    clientPost.mockResolvedValue(envelope(null));
    dbResults = [[PARTNER_ROW]];
    await expect(svc.initiateRegistration('opr_000000000001')).rejects.toThrow(
      'Partner returned no credentials',
    );
  });

  it('posts token A with token C, stores token B and clears token C', async () => {
    const theirs = { ...PARTNER_CREDENTIALS, token: 'token-B-from-partner' };
    partnerOffers(BOTH);
    clientPost.mockResolvedValue(envelope(theirs));
    dbResults = [[PARTNER_ROW]];

    const result = await svc.initiateRegistration('opr_000000000001', '2.3.0');
    expect(result).toEqual(theirs);

    // POST went to the partner credentials endpoint with our credentials.
    expect(clientPost).toHaveBeenCalledTimes(1);
    const [postUrl, postBody] = clientPost.mock.calls[0] as [string, { token: string }];
    expect(postUrl).toBe('https://partner.example.com/creds');
    // The POST client used token C and routed to the partner.
    expect(clientOptions[1]).toMatchObject({
      token: 'token-C-registration',
      toCountryCode: 'NL',
      toPartyId: 'ABC',
    });
    // Token A sent in the POST is the issued token we stored.
    const inserts = opsOn(ocpiCredentialsTokens, 'insert').map(
      (o) => o.values as Record<string, unknown>,
    );
    const issued = inserts.find((v) => v['direction'] === 'issued');
    const received = inserts.find((v) => v['direction'] === 'received');
    await expect(argon2.verify(issued?.['tokenHash'] as string, postBody.token)).resolves.toBe(
      true,
    );
    expect(decryptString(received?.['outboundTokenEnc'] as string, KEY)).toBe(
      'token-B-from-partner',
    );
    expect(received?.['tokenPrefix']).toBe('token-B-');

    // Endpoints rediscovered with token B.
    expect(clientOptions[2]).toMatchObject({ token: 'token-B-from-partner' });
    expect(opsOn(ocpiPartnerEndpoints, 'insert')[0]?.values).toHaveLength(2);

    const [partnerUpdate] = opsOn(ocpiPartners, 'update');
    expect(partnerUpdate?.set).toMatchObject({
      status: 'connected',
      version: '2.3.0',
      versionUrl: VERSIONS_URL,
      partnerRegistrationTokenEnc: null,
    });
  });

  it('skips the endpoint insert when rediscovery returns none', async () => {
    let detailCalls = 0;
    clientGet.mockImplementation((url: string) => {
      if (url === VERSIONS_URL) return Promise.resolve(envelope(BOTH));
      detailCalls++;
      return Promise.resolve(
        envelope({ version: '2.2.1', endpoints: detailCalls === 1 ? ENDPOINTS : [] }),
      );
    });
    clientPost.mockResolvedValue(envelope({ ...PARTNER_CREDENTIALS, token: 'token-B-xyz' }));
    dbResults = [[PARTNER_ROW]];
    await svc.initiateRegistration('opr_000000000001');
    expect(opsOn(ocpiPartnerEndpoints, 'delete')).toHaveLength(1);
    expect(opsOn(ocpiPartnerEndpoints, 'insert')).toHaveLength(0);
  });
});
