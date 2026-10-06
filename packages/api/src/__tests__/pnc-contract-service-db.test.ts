// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, vi } from 'vitest';

type Chain = Record<string, ReturnType<typeof vi.fn>> & {
  then: (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => Promise<unknown>;
};

// Each awaited query chain answers with the next queued result (or rejects
// with it when it is an Error).
let dbResults: unknown[] = [];
let dbCallIndex = 0;
const chains: Array<{ kind: string; chain: Chain }> = [];
function setupDbResults(...results: unknown[]): void {
  dbResults = results;
  dbCallIndex = 0;
}
function makeChain(kind: string): Chain {
  const chain = {} as Chain;
  for (const m of [
    'select',
    'from',
    'where',
    'innerJoin',
    'orderBy',
    'values',
    'returning',
    'set',
  ]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve, reject) => {
    const r = dbResults[dbCallIndex] ?? [];
    dbCallIndex++;
    if (r instanceof Error) return Promise.reject(r).then(resolve, reject);
    return Promise.resolve(r).then(resolve, reject);
  };
  chains.push({ kind, chain });
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain('select')),
    insert: vi.fn(() => makeChain('insert')),
    update: vi.fn(() => makeChain('update')),
  },
  drivers: { id: 'drivers.id' },
  driverTokens: { id: 'dt.id', driverId: 'dt.driverId', idToken: 'dt.idToken' },
  pncContracts: {
    id: 'pc.id',
    driverTokenId: 'pc.driverTokenId',
    pcid: 'pc.pcid',
    status: 'pc.status',
    createdAt: 'pc.createdAt',
    revokedAt: 'pc.revokedAt',
  },
  settings: { key: 'settings.key', value: 'settings.value' },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  desc: vi.fn((c: unknown) => ({ desc: c })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
}));

vi.mock('../services/token.service.js', () => {
  class DuplicateTokenError extends Error {
    constructor(
      public readonly idToken: string,
      public readonly tokenType: string,
    ) {
      super(`Token ${idToken} already exists`);
    }
  }
  return {
    DuplicateTokenError,
    createToken: vi.fn(),
    deleteToken: vi.fn(),
    updateToken: vi.fn(),
  };
});

import { eq, inArray } from 'drizzle-orm';
import { db } from '@evtivity/database';
import * as tokenService from '../services/token.service.js';
import {
  createContract,
  listDriverContracts,
  revokeContract,
} from '../services/pnc-contract.service.js';

const DRIVER_ID = 'drv_000000000001';
const TOKEN_ID = 'dtk_000000000001';
const ACTOR = { type: 'operator', userId: 'usr_000000000001' } as const;

const mockCreateToken = vi.mocked(tokenService.createToken);
const mockDeleteToken = vi.mocked(tokenService.deleteToken);
const mockUpdateToken = vi.mocked(tokenService.updateToken);

function contractRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5,
    driverId: DRIVER_ID,
    driverTokenId: TOKEN_ID,
    emaid: 'USEVTCABCD1234',
    pcid: 'WMIV0001X',
    status: 'active',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    revokedAt: null,
    ...overrides,
  };
}

const goodSettings = [
  { key: 'pnc.local.caEnc', value: 'ciphertext' },
  { key: 'pnc.local.emaidCountry', value: 'US' },
  { key: 'pnc.local.emaidProviderId', value: 'EVT' },
];

describe('pnc-contract.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDbResults();
    chains.length = 0;
  });

  describe('listDriverContracts', () => {
    it('returns the driver contracts and maps a missing driverId to an empty string', async () => {
      setupDbResults([contractRow(), contractRow({ id: 4, driverId: null, status: 'revoked' })]);
      const result = await listDriverContracts(DRIVER_ID);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ id: 5, driverId: DRIVER_ID, emaid: 'USEVTCABCD1234' });
      expect(result[1]).toMatchObject({ id: 4, driverId: '', status: 'revoked' });
      expect(eq).toHaveBeenCalledWith('dt.driverId', DRIVER_ID);
      expect(eq).toHaveBeenCalledWith('dt.id', 'pc.driverTokenId');
    });
  });

  describe('createContract', () => {
    it.each(['---', '', 'A'.repeat(65)])(
      'rejects PCID %j with 400 VALIDATION_ERROR before any query',
      async (pcid) => {
        await expect(createContract(DRIVER_ID, pcid, ACTOR)).rejects.toMatchObject({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
        });
        expect(db.select).not.toHaveBeenCalled();
      },
    );

    it('accepts a PCID of exactly 64 characters', async () => {
      const pcid = 'B'.repeat(64);
      setupDbResults(
        [{ id: DRIVER_ID }],
        goodSettings,
        [{ id: 9 }],
        [contractRow({ id: 9, pcid })],
      );
      mockCreateToken.mockResolvedValue({ id: TOKEN_ID } as never);
      const contract = await createContract(DRIVER_ID, pcid, ACTOR);
      expect(contract.pcid).toBe(pcid);
    });

    it('throws 404 DRIVER_NOT_FOUND for an unknown driver', async () => {
      setupDbResults([]);
      await expect(createContract(DRIVER_ID, 'wmi-1', ACTOR)).rejects.toMatchObject({
        statusCode: 404,
        code: 'DRIVER_NOT_FOUND',
      });
      expect(mockCreateToken).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', []],
      ['empty', [{ key: 'pnc.local.caEnc', value: '' }]],
      ['non-string', [{ key: 'pnc.local.caEnc', value: 42 }]],
    ])('throws 409 LOCAL_CA_NOT_CONFIGURED when the CA is %s', async (_label, rows) => {
      setupDbResults([{ id: DRIVER_ID }], rows);
      await expect(createContract(DRIVER_ID, 'wmi-1', ACTOR)).rejects.toMatchObject({
        statusCode: 409,
        code: 'LOCAL_CA_NOT_CONFIGURED',
      });
      expect(inArray).toHaveBeenCalledWith('settings.key', [
        'pnc.local.caEnc',
        'pnc.local.emaidCountry',
        'pnc.local.emaidProviderId',
      ]);
      expect(mockCreateToken).not.toHaveBeenCalled();
    });

    it.each([
      ['lowercase country', 'us', 'EVT'],
      ['three-letter country', 'USA', 'EVT'],
      ['non-string country', 1, 'EVT'],
      ['short provider', 'US', 'EV'],
      ['lowercase provider', 'US', 'evt'],
      ['missing provider', 'US', undefined],
    ])('throws 409 EMAID_PREFIX_NOT_CONFIGURED for %s', async (_label, country, provider) => {
      const rows: Array<{ key: string; value: unknown }> = [
        { key: 'pnc.local.caEnc', value: 'ciphertext' },
        { key: 'pnc.local.emaidCountry', value: country },
      ];
      if (provider !== undefined) rows.push({ key: 'pnc.local.emaidProviderId', value: provider });
      setupDbResults([{ id: DRIVER_ID }], rows);
      await expect(createContract(DRIVER_ID, 'wmi-1', ACTOR)).rejects.toMatchObject({
        statusCode: 409,
        code: 'EMAID_PREFIX_NOT_CONFIGURED',
      });
      expect(mockCreateToken).not.toHaveBeenCalled();
    });

    it('creates an eMAID token and a contract bound to the normalized PCID', async () => {
      setupDbResults([{ id: DRIVER_ID }], goodSettings, [{ id: 5 }], [contractRow()]);
      mockCreateToken.mockResolvedValue({ id: TOKEN_ID } as never);
      const contract = await createContract(DRIVER_ID, 'wmi-v 0001.x', ACTOR);
      expect(contract).toEqual({
        id: 5,
        driverId: DRIVER_ID,
        driverTokenId: TOKEN_ID,
        emaid: 'USEVTCABCD1234',
        pcid: 'WMIV0001X',
        status: 'active',
        createdAt: new Date('2026-10-01T00:00:00Z'),
        revokedAt: null,
      });
      const [tokenData, actor] = mockCreateToken.mock.calls[0] ?? [];
      expect(actor).toEqual(ACTOR);
      expect(tokenData).toMatchObject({ driverId: DRIVER_ID, tokenType: 'eMAID' });
      expect(tokenData?.idToken).toMatch(/^USEVTC[0-9A-Z]{8}$/);
      const insert = chains.find((c) => c.kind === 'insert');
      expect(insert?.chain['values']).toHaveBeenCalledWith({
        driverTokenId: TOKEN_ID,
        pcid: 'WMIV0001X',
      });
      expect(eq).toHaveBeenCalledWith('pc.id', 5);
      expect(mockDeleteToken).not.toHaveBeenCalled();
    });

    it('retries with a new eMAID when the token is a duplicate', async () => {
      setupDbResults([{ id: DRIVER_ID }], goodSettings, [{ id: 5 }], [contractRow()]);
      mockCreateToken
        .mockRejectedValueOnce(new tokenService.DuplicateTokenError('X', 'eMAID'))
        .mockRejectedValueOnce(new tokenService.DuplicateTokenError('Y', 'eMAID'))
        .mockResolvedValueOnce({ id: TOKEN_ID } as never);
      const contract = await createContract(DRIVER_ID, 'wmi-1', ACTOR);
      expect(contract.id).toBe(5);
      expect(mockCreateToken).toHaveBeenCalledTimes(3);
    });

    it('gives up after five duplicate eMAIDs', async () => {
      setupDbResults([{ id: DRIVER_ID }], goodSettings);
      mockCreateToken.mockRejectedValue(new tokenService.DuplicateTokenError('X', 'eMAID'));
      await expect(createContract(DRIVER_ID, 'wmi-1', ACTOR)).rejects.toThrow(
        'Could not allocate a unique eMAID',
      );
      expect(mockCreateToken).toHaveBeenCalledTimes(5);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rethrows a non-duplicate token error without retrying', async () => {
      setupDbResults([{ id: DRIVER_ID }], goodSettings);
      mockCreateToken.mockRejectedValue(new Error('db down'));
      await expect(createContract(DRIVER_ID, 'wmi-1', ACTOR)).rejects.toThrow('db down');
      expect(mockCreateToken).toHaveBeenCalledTimes(1);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('deletes the orphan eMAID token when the contract insert fails', async () => {
      setupDbResults([{ id: DRIVER_ID }], goodSettings, new Error('unique violation'));
      mockCreateToken.mockResolvedValue({ id: TOKEN_ID } as never);
      await expect(createContract(DRIVER_ID, 'wmi-1', ACTOR)).rejects.toThrow('unique violation');
      expect(mockDeleteToken).toHaveBeenCalledWith(TOKEN_ID, ACTOR);
    });

    it('deletes the eMAID token when the insert returns no row', async () => {
      setupDbResults([{ id: DRIVER_ID }], goodSettings, []);
      mockCreateToken.mockResolvedValue({ id: TOKEN_ID } as never);
      await expect(createContract(DRIVER_ID, 'wmi-1', ACTOR)).rejects.toThrow(
        'Contract insert returned no row',
      );
      expect(mockDeleteToken).toHaveBeenCalledWith(TOKEN_ID, ACTOR);
    });

    it('deletes the eMAID token when the inserted contract cannot be read back', async () => {
      setupDbResults([{ id: DRIVER_ID }], goodSettings, [{ id: 5 }], []);
      mockCreateToken.mockResolvedValue({ id: TOKEN_ID } as never);
      await expect(createContract(DRIVER_ID, 'wmi-1', ACTOR)).rejects.toThrow(
        'Contract insert returned no row',
      );
      expect(mockDeleteToken).toHaveBeenCalledWith(TOKEN_ID, ACTOR);
    });
  });

  describe('revokeContract', () => {
    it('throws 404 PNC_CONTRACT_NOT_FOUND for an unknown contract', async () => {
      setupDbResults([]);
      await expect(revokeContract(DRIVER_ID, 5, ACTOR)).rejects.toMatchObject({
        statusCode: 404,
        code: 'PNC_CONTRACT_NOT_FOUND',
      });
      expect(db.update).not.toHaveBeenCalled();
    });

    it("throws 404 PNC_CONTRACT_NOT_FOUND for another driver's contract", async () => {
      setupDbResults([contractRow({ driverId: 'drv_000000000099' })]);
      await expect(revokeContract(DRIVER_ID, 5, ACTOR)).rejects.toMatchObject({
        statusCode: 404,
        code: 'PNC_CONTRACT_NOT_FOUND',
      });
      expect(db.update).not.toHaveBeenCalled();
      expect(mockUpdateToken).not.toHaveBeenCalled();
    });

    it('revokes an active contract and deactivates its eMAID token', async () => {
      const revokedAt = new Date('2026-10-05T00:00:00Z');
      setupDbResults(
        [contractRow()],
        [{ driverTokenId: TOKEN_ID }],
        [contractRow({ status: 'revoked', revokedAt })],
      );
      const result = await revokeContract(DRIVER_ID, 5, ACTOR);
      expect(result).toMatchObject({ id: 5, status: 'revoked', revokedAt });
      const update = chains.find((c) => c.kind === 'update');
      const setArg = update?.chain['set']?.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(setArg['status']).toBe('revoked');
      expect(setArg['revokedAt']).toBeInstanceOf(Date);
      expect(setArg['updatedAt']).toBeInstanceOf(Date);
      // Only an active contract moves to revoked (revoked is terminal).
      expect(eq).toHaveBeenCalledWith('pc.status', 'active');
      expect(mockUpdateToken).toHaveBeenCalledWith(TOKEN_ID, { isActive: false }, ACTOR);
    });

    it('is idempotent: an already revoked contract does not touch the token', async () => {
      setupDbResults(
        [contractRow({ status: 'revoked' })],
        [],
        [contractRow({ status: 'revoked' })],
      );
      const result = await revokeContract(DRIVER_ID, 5, ACTOR);
      expect(result.status).toBe('revoked');
      expect(mockUpdateToken).not.toHaveBeenCalled();
    });

    it('throws 404 when the contract disappears after the update', async () => {
      setupDbResults([contractRow()], [{ driverTokenId: TOKEN_ID }], []);
      await expect(revokeContract(DRIVER_ID, 5, ACTOR)).rejects.toMatchObject({
        statusCode: 404,
        code: 'PNC_CONTRACT_NOT_FOUND',
      });
    });
  });
});
