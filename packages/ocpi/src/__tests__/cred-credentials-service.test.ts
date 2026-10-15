// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as argon2 from 'argon2';
import { decryptString, encryptString } from '@evtivity/lib';
import {
  ocpiCredentialsTokens,
  ocpiPartnerAuditLog,
  ocpiPartnerEndpoints,
  ocpiPartners,
} from '@evtivity/database';

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
  for (const m of ['where', 'limit', 'for']) {
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

const { clientGet, clientPost, clientOptions, mockWriteAudit, mockTransaction } = vi.hoisted(
  () => ({
    mockWriteAudit: vi.fn(),
    mockTransaction: vi.fn(),
    clientGet: vi.fn(),
    clientPost: vi.fn(),
    clientOptions: [] as unknown[],
  }),
);

vi.mock('@evtivity/database', async (importOriginal) => {
  const fakeDb: Record<string, unknown> = {
    select: vi.fn(() => makeChain({ op: 'select', table: null })),
    insert: vi.fn((table: unknown) => makeChain({ op: 'insert', table })),
    update: vi.fn((table: unknown) => makeChain({ op: 'update', table })),
    delete: vi.fn((table: unknown) => makeChain({ op: 'delete', table })),
  };
  // The transaction runs its callback on the same recorder.
  fakeDb['transaction'] = mockTransaction;
  mockTransaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(fakeDb));
  return {
    ...(await importOriginal<typeof import('@evtivity/database')>()),
    writeAudit: mockWriteAudit,
    db: fakeDb,
  };
});

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
  mockWriteAudit.mockReset().mockResolvedValue(undefined);
  mockTransaction.mockClear();
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
  it('stores an argon2 hash and the 8-char prefix of a 64-hex credentials token', async () => {
    const token = await svc.generateAndStoreToken('opr_000000000001', 'issued');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const [insert] = opsOn(ocpiCredentialsTokens, 'insert');
    const values = insert?.values as Record<string, unknown>;
    expect(values).toMatchObject({
      partnerId: 'opr_000000000001',
      tokenPrefix: token.slice(0, 8),
      direction: 'issued',
      kind: 'credentials',
      isActive: true,
    });
    expect(values['tokenHash']).not.toBe(token);
    await expect(argon2.verify(values['tokenHash'] as string, token)).resolves.toBe(true);
  });

  it('generates a different token each time', async () => {
    const a = await svc.generateAndStoreToken('opr_000000000001', 'issued');
    const b = await svc.generateAndStoreToken('opr_000000000001', 'issued');
    expect(a).not.toBe(b);
  });
});

const PENDING_PARTNER = {
  id: 'opr_000000000042',
  name: 'Pre-created NL',
  countryCode: 'NL',
  partyId: 'ABC',
  status: 'pending',
  version: null,
  versionUrl: null,
  allowPrivateNetwork: false,
  allowRawToken: false,
};
const AUTH = { tokenId: 9, partnerId: 'opr_000000000042' };

describe('handleRegistration', () => {
  it('refuses roles of another party (no takeover of a partner by country and party)', async () => {
    dbResults = [[PENDING_PARTNER]];
    const other = {
      ...PARTNER_CREDENTIALS,
      roles: [{ ...PARTNER_CREDENTIALS.roles[0]!, country_code: 'DE', party_id: 'XYZ' }],
    };
    const err = await svc.handleRegistration(other, AUTH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(svc.CredentialsError);
    expect(err).toMatchObject({ httpStatus: 400, ocpiStatus: 2001 });
    expect(clientGet).not.toHaveBeenCalled();
    expect(ops.filter((o) => o.op !== 'select')).toHaveLength(0);
  });

  it('refuses a second role naming another party', async () => {
    dbResults = [[PENDING_PARTNER]];
    const mixed = {
      ...PARTNER_CREDENTIALS,
      roles: [
        PARTNER_CREDENTIALS.roles[0]!,
        { ...PARTNER_CREDENTIALS.roles[0]!, role: 'HUB' as const, party_id: 'HUB' },
      ],
    };
    await expect(svc.handleRegistration(mixed, AUTH)).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('answers 405 for a partner already connected', async () => {
    dbResults = [[{ ...PENDING_PARTNER, status: 'connected' }]];
    await expect(svc.handleRegistration(PARTNER_CREDENTIALS, AUTH)).rejects.toMatchObject({
      httpStatus: 405,
    });
    expect(clientGet).not.toHaveBeenCalled();
  });

  it('answers 401 when the token partner no longer exists', async () => {
    dbResults = [[]];
    await expect(svc.handleRegistration(PARTNER_CREDENTIALS, AUTH)).rejects.toMatchObject({
      httpStatus: 401,
    });
  });

  it('refuses a registration token another request already claimed, writing nothing', async () => {
    partnerOffers(BOTH);
    dbResults = [[PENDING_PARTNER], []]; // partner, claim UPDATE ... RETURNING no row
    const err = await svc.handleRegistration(PARTNER_CREDENTIALS, AUTH).catch((e: unknown) => e);
    expect(err).toMatchObject({ httpStatus: 401, message: 'Invalid token' });
    expect(opsOn(ocpiPartners, 'update')).toHaveLength(0);
    expect(opsOn(ocpiCredentialsTokens, 'insert')).toHaveLength(0);
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it('maps a failing partner API to 3001 without its message, keeping the token', async () => {
    clientGet.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:443 secret detail'));
    dbResults = [[PENDING_PARTNER]];
    const err = await svc.handleRegistration(PARTNER_CREDENTIALS, AUTH).catch((e: unknown) => e);
    expect(err).toMatchObject({ httpStatus: 400, ocpiStatus: 3001 });
    expect((err as Error).message).not.toContain('ECONNREFUSED');
    // Nothing claimed: the registration token stays usable.
    expect(ops.filter((o) => o.op === 'update')).toHaveLength(0);
  });

  it('connects the bound partner, stores endpoints and both tokens in one transaction', async () => {
    partnerOffers(BOTH);
    dbResults = [[PENDING_PARTNER], [{ id: 9 }], [{ status: 'pending' }]];
    const result = await svc.handleRegistration(PARTNER_CREDENTIALS, AUTH, '2.3.0');

    expect(clientGet.mock.calls.map((c) => c[0])).toEqual([
      VERSIONS_URL,
      'https://partner.example.com/ocpi/2.3.0',
    ]);
    expect(clientOptions[0]).toMatchObject({
      token: PARTNER_CREDENTIALS.token,
      allowPrivateNetwork: false,
      rawToken: false,
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);

    const [claim] = opsOn(ocpiCredentialsTokens, 'update');
    expect(claim).toMatchObject({ set: { isActive: false }, returning: true });

    expect(opsOn(ocpiPartners, 'insert')).toHaveLength(0);
    const [partnerUpdate] = opsOn(ocpiPartners, 'update');
    expect(partnerUpdate?.set).toMatchObject({
      name: 'Partner NL',
      status: 'connected',
      version: '2.3.0',
      versionUrl: VERSIONS_URL,
      roles: PARTNER_CREDENTIALS.roles,
      partnerRegistrationTokenEnc: null,
    });
    expect(opsOn(ocpiPartnerEndpoints, 'insert')[0]?.values).toHaveLength(2);

    const tokenInserts = opsOn(ocpiCredentialsTokens, 'insert').map(
      (o) => o.values as Record<string, unknown>,
    );
    const received = tokenInserts.find((v) => v['direction'] === 'received');
    const issued = tokenInserts.find((v) => v['direction'] === 'issued');
    expect(decryptString(received?.['outboundTokenEnc'] as string, KEY)).toBe(
      PARTNER_CREDENTIALS.token,
    );
    expect(issued).toMatchObject({ kind: 'credentials', partnerId: 'opr_000000000042' });
    await expect(argon2.verify(issued?.['tokenHash'] as string, result.token)).resolves.toBe(true);

    expect(mockWriteAudit).toHaveBeenCalledTimes(1);
    const [config, args] = mockWriteAudit.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(config).toEqual({ table: ocpiPartnerAuditLog, idColumn: 'ocpi_partner_id' });
    expect(args).toMatchObject({
      entityId: 'opr_000000000042',
      action: 'registered',
      actor: 'system',
      actorLabel: 'ocpi-credentials',
      after: { status: 'connected', version: '2.3.0', endpointCount: 2 },
    });
    const stored = JSON.stringify(args);
    expect(stored).not.toContain(PARTNER_CREDENTIALS.token);
    expect(stored).not.toContain(result.token);
  });

  it('honors the partner private-network and raw token flags', async () => {
    partnerOffers([{ version: '2.2.1', url: 'https://partner.example.com/ocpi/2.2.1' }], []);
    dbResults = [
      [{ ...PENDING_PARTNER, allowPrivateNetwork: true, allowRawToken: true }],
      [{ id: 9 }],
      [{ status: 'pending' }],
    ];
    await svc.handleRegistration(PARTNER_CREDENTIALS, AUTH, '2.3.0');
    expect(clientGet).toHaveBeenLastCalledWith('https://partner.example.com/ocpi/2.2.1');
    expect(clientOptions[0]).toMatchObject({ allowPrivateNetwork: true, rawToken: true });
    expect(opsOn(ocpiPartnerEndpoints, 'insert')).toHaveLength(0);
  });

  it('answers 405 when the partner got connected while the request ran', async () => {
    partnerOffers(BOTH);
    dbResults = [[PENDING_PARTNER], [{ id: 9 }], [{ status: 'connected' }]];
    await expect(svc.handleRegistration(PARTNER_CREDENTIALS, AUTH)).rejects.toMatchObject({
      httpStatus: 405,
    });
    expect(opsOn(ocpiPartners, 'update')).toHaveLength(0);
  });

  it.each([
    ['no versions', () => clientGet.mockResolvedValue(envelope([]))],
    ['a versions payload that is not an array', () => clientGet.mockResolvedValue(envelope(null))],
    [
      'no supported version',
      () => partnerOffers([{ version: '2.1.1', url: 'https://partner.example.com/ocpi/2.1.1' }]),
    ],
    ['a version detail without endpoints', () => partnerOffers(BOTH, null)],
  ])('answers 3001 for %s', async (_label, setup) => {
    setup();
    dbResults = [[PENDING_PARTNER]];
    await expect(svc.handleRegistration(PARTNER_CREDENTIALS, AUTH)).rejects.toMatchObject({
      ocpiStatus: 3001,
    });
  });
});

describe('handleCredentialUpdate', () => {
  const CONNECTED = { ...PENDING_PARTNER, status: 'connected', name: 'Old NL', version: '2.1.1' };

  it('refuses roles of another party', async () => {
    dbResults = [[CONNECTED]];
    const other = {
      ...PARTNER_CREDENTIALS,
      roles: [{ ...PARTNER_CREDENTIALS.roles[0]!, party_id: 'XYZ' }],
    };
    await expect(svc.handleCredentialUpdate(other, 'opr_000000000042')).rejects.toMatchObject({
      httpStatus: 400,
      ocpiStatus: 2001,
    });
  });

  it('refreshes the partner, endpoints and both tokens, keeping its status', async () => {
    partnerOffers(BOTH);
    dbResults = [[{ ...CONNECTED, allowPrivateNetwork: true }]];
    const result = await svc.handleCredentialUpdate(PARTNER_CREDENTIALS, 'opr_000000000042');
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({
      entityId: 'opr_000000000042',
      action: 'updated',
      actor: 'system',
      after: { name: 'Partner NL', status: 'connected', version: '2.2.1', endpointCount: 2 },
    });
    expect(clientOptions[0]).toMatchObject({ allowPrivateNetwork: true });
    const [partnerUpdate] = opsOn(ocpiPartners, 'update');
    expect(partnerUpdate?.set?.['status']).toBeUndefined();
    const inserts = opsOn(ocpiCredentialsTokens, 'insert').map(
      (o) => o.values as Record<string, unknown>,
    );
    expect(inserts.map((v) => v['direction'])).toEqual(['received', 'issued']);
    expect(inserts[1]?.['tokenPrefix']).toBe(result.token.slice(0, 8));
  });

  it('completes the handshake of a pending partner (connected, token C cleared)', async () => {
    partnerOffers(BOTH, []);
    dbResults = [[PENDING_PARTNER]];
    await svc.handleCredentialUpdate(PARTNER_CREDENTIALS, 'opr_000000000042', '2.3.0');
    const [partnerUpdate] = opsOn(ocpiPartners, 'update');
    expect(partnerUpdate?.set).toMatchObject({
      status: 'connected',
      partnerRegistrationTokenEnc: null,
    });
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({ action: 'registered' });
  });

  it('keeps a suspended partner suspended', async () => {
    partnerOffers(BOTH, []);
    dbResults = [[{ ...CONNECTED, status: 'suspended' }]];
    await svc.handleCredentialUpdate(PARTNER_CREDENTIALS, 'opr_000000000042');
    const [partnerUpdate] = opsOn(ocpiPartners, 'update');
    expect(partnerUpdate?.set?.['status']).toBeUndefined();
  });

  it('answers 405 when the partner row is missing', async () => {
    dbResults = [[]];
    await expect(
      svc.handleCredentialUpdate(PARTNER_CREDENTIALS, 'opr_000000000042'),
    ).rejects.toMatchObject({ httpStatus: 405 });
  });
});

describe('handleUnregister', () => {
  it('disconnects the partner and deactivates all its tokens', async () => {
    await svc.handleUnregister('opr_000000000001');
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ op: 'update', table: ocpiPartners });
    expect(ops[0]?.set).toMatchObject({ status: 'disconnected' });
    expect(ops[0]?.set?.['updatedAt']).toBeInstanceOf(Date);
    expect(ops[1]).toMatchObject({
      op: 'update',
      table: ocpiCredentialsTokens,
      set: { isActive: false },
    });
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({
      entityId: 'opr_000000000001',
      action: 'disconnected',
      actor: 'system',
      after: { status: 'disconnected' },
    });
  });
});

describe('initiateRegistration', () => {
  const PARTNER_ROW = {
    id: 'opr_000000000001',
    countryCode: 'NL',
    partyId: 'ABC',
    status: 'pending',
    versionUrl: VERSIONS_URL,
    allowPrivateNetwork: false,
    allowRawToken: false,
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

  it('fails for a connected partner', async () => {
    dbResults = [[{ ...PARTNER_ROW, status: 'connected' }]];
    await expect(svc.initiateRegistration('opr_000000000001')).rejects.toThrow(
      'Partner already connected',
    );
  });

  it('retires only the new token A when the partner returns no credentials', async () => {
    partnerOffers(BOTH);
    clientPost.mockResolvedValue(envelope(null));
    dbResults = [[PARTNER_ROW], [{ id: 77 }]];
    await expect(svc.initiateRegistration('opr_000000000001')).rejects.toThrow(
      'Partner returned no credentials',
    );
    // The earlier issued tokens stay active: one update, the new token only.
    const updates = opsOn(ocpiCredentialsTokens, 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.set).toEqual({ isActive: false });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it('posts token A with token C, stores token B and clears token C', async () => {
    const theirs = { ...PARTNER_CREDENTIALS, token: 'token-B-from-partner' };
    partnerOffers(BOTH);
    clientPost.mockResolvedValue(envelope(theirs));
    dbResults = [[PARTNER_ROW], [{ id: 77 }]];

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
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({
      entityId: 'opr_000000000001',
      action: 'registered',
      actor: 'system',
      after: { status: 'connected', version: '2.3.0', versionUrl: VERSIONS_URL, endpointCount: 2 },
    });
    const stored = JSON.stringify(mockWriteAudit.mock.calls[0]?.[1]);
    expect(stored).not.toContain('token-B-from-partner');
    expect(stored).not.toContain('token-C-registration');
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
    dbResults = [[PARTNER_ROW], [{ id: 77 }]];
    await svc.initiateRegistration('opr_000000000001');
    expect(opsOn(ocpiPartnerEndpoints, 'delete')).toHaveLength(1);
    expect(opsOn(ocpiPartnerEndpoints, 'insert')).toHaveLength(0);
  });
});
