// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Each awaited query takes the next queued result. An Error rejects it.
let dbResults: unknown[] = [];
let dbCallIndex = 0;
type Chain = Record<string, ReturnType<typeof vi.fn>> & { then: unknown };
const chains: { kind: string; chain: Chain }[] = [];
function makeChain(kind: string): Chain {
  const chain = {} as Chain;
  for (const m of ['from', 'where', 'set', 'returning']) chain[m] = vi.fn(() => chain);
  chain.then = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
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
    update: vi.fn(() => makeChain('update')),
  },
  driverTokens: { id: 'id', driverId: 'driver_id', isActive: 'is_active' },
  userTokens: { driverId: 'driver_id', type: 'type', revokedAt: 'revoked_at' },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ inArray: [col, vals] })),
  isNull: vi.fn((col: unknown) => ({ isNull: col })),
}));

const { bulkSetActiveMock, revokeAllMock, announceMock } = vi.hoisted(() => ({
  bulkSetActiveMock: vi.fn(),
  revokeAllMock: vi.fn(),
  announceMock: vi.fn(),
}));
vi.mock('../services/token.service.js', () => ({ bulkSetActive: bulkSetActiveMock }));
vi.mock('../services/refresh-token.service.js', () => ({
  revokeAllDriverRefreshTokens: revokeAllMock,
}));
vi.mock('../lib/driver-active.js', () => ({ announceDriverDeactivated: announceMock }));

import { inArray } from 'drizzle-orm';
import {
  applyDriverDeactivation,
  revokeDriverEmailLinks,
  DRIVER_EMAIL_LINK_TYPES,
} from '../services/driver-status.service.js';
import type { AuditActorInfo } from '../lib/audit-actor.js';

const DRIVER_ID = 'drv_000000000001';
const operator: AuditActorInfo = {
  actor: 'operator',
  actorUserId: 'usr_000000000001',
  actorDriverId: null,
  actorApiKeyId: null,
  actorLabel: null,
};
const log = { warn: vi.fn() };

describe('driver-status.service', () => {
  beforeEach(() => {
    dbResults = [];
    dbCallIndex = 0;
    chains.length = 0;
    bulkSetActiveMock.mockResolvedValue({ updated: 2 });
    revokeAllMock.mockResolvedValue(undefined);
  });

  describe('revokeDriverEmailLinks', () => {
    it('revokes the open invitation, reset and verification links of the driver', async () => {
      await revokeDriverEmailLinks(DRIVER_ID);
      const update = chains.find((c) => c.kind === 'update')?.chain;
      expect(update?.['set']).toHaveBeenCalledWith({ revokedAt: expect.any(Date) });
      expect(inArray).toHaveBeenCalledWith('type', [...DRIVER_EMAIL_LINK_TYPES]);
      expect(DRIVER_EMAIL_LINK_TYPES).toEqual([
        'portal_invite',
        'password_reset',
        'email_verification',
      ]);
    });
  });

  describe('applyDriverDeactivation', () => {
    it('ends the streams, revokes sessions and links, and deactivates the active tokens', async () => {
      // 1: revoke links, 2: active token lookup
      dbResults = [[], [{ id: 'dtk_000000000001' }, { id: 'dtk_000000000002' }]];
      const result = await applyDriverDeactivation(DRIVER_ID, { actor: operator, log });
      expect(announceMock).toHaveBeenCalledWith(DRIVER_ID);
      expect(revokeAllMock).toHaveBeenCalledWith(DRIVER_ID);
      expect(bulkSetActiveMock).toHaveBeenCalledWith(
        ['dtk_000000000001', 'dtk_000000000002'],
        false,
        { type: 'operator', userId: 'usr_000000000001' },
      );
      expect(result).toEqual({ tokensDeactivated: 2 });
    });

    it('reads only the active tokens, so a repeat does not deactivate or notify twice', async () => {
      dbResults = [[], []];
      const result = await applyDriverDeactivation(DRIVER_ID, { actor: operator, log });
      const select = chains.find((c) => c.kind === 'select')?.chain;
      expect(select?.['where']).toHaveBeenCalledWith({
        and: [{ eq: ['driver_id', DRIVER_ID] }, { eq: ['is_active', true] }],
      });
      expect(bulkSetActiveMock).not.toHaveBeenCalled();
      expect(result).toEqual({ tokensDeactivated: 0 });
    });

    it('records an API key request as its operator and a system request as system', async () => {
      dbResults = [[], [{ id: 'dtk_000000000001' }]];
      await applyDriverDeactivation(DRIVER_ID, {
        actor: { ...operator, actor: 'api_key', actorApiKeyId: 'key_1' },
        log,
      });
      expect(bulkSetActiveMock).toHaveBeenLastCalledWith(['dtk_000000000001'], false, {
        type: 'operator',
        userId: 'usr_000000000001',
      });

      dbResults = [[], [{ id: 'dtk_000000000001' }]];
      dbCallIndex = 0;
      await applyDriverDeactivation(DRIVER_ID, {
        actor: { ...operator, actor: 'system', actorUserId: null },
        log,
      });
      expect(bulkSetActiveMock).toHaveBeenLastCalledWith(['dtk_000000000001'], false, {
        type: 'system',
      });
    });

    it('still deactivates the tokens when revoking the sessions fails (fail-open)', async () => {
      revokeAllMock.mockRejectedValueOnce(new Error('db down'));
      dbResults = [[{ id: 'dtk_000000000001' }]];
      const result = await applyDriverDeactivation(DRIVER_ID, { actor: operator, log });
      expect(log.warn).toHaveBeenCalled();
      expect(bulkSetActiveMock).toHaveBeenCalled();
      expect(result.tokensDeactivated).toBe(2);
    });

    it('throws when the token deactivation fails, so the caller can retry', async () => {
      bulkSetActiveMock.mockRejectedValueOnce(new Error('db down'));
      dbResults = [[], [{ id: 'dtk_000000000001' }]];
      await expect(applyDriverDeactivation(DRIVER_ID, { actor: operator, log })).rejects.toThrow(
        'db down',
      );
    });
  });
});
