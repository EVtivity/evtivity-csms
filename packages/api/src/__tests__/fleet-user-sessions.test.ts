// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  writeAudit: vi.fn(() => Promise.resolve()),
  endUserSessions: vi.fn(() => Promise.resolve(1)),
  invalidateSiteAccessCache: vi.fn(),
  invalidatePermissionCache: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: {},
  userAuditLog: 'user_audit_log',
  userFleetAssignments: {},
  writeAudit: h.writeAudit,
}));
vi.mock('../lib/operator-session.js', () => ({ endUserSessions: h.endUserSessions }));
vi.mock('../lib/site-access.js', () => ({
  invalidateSiteAccessCache: h.invalidateSiteAccessCache,
}));
vi.mock('../middleware/rbac.js', () => ({
  invalidatePermissionCache: h.invalidatePermissionCache,
}));

import { endDeletedFleetUserSessions } from '../lib/fleet-user-sessions.js';

const actor = { actor: 'operator', actorUserId: 'usr_admin', actorApiKeyId: null } as never;
const log = { warn: vi.fn() } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('endDeletedFleetUserSessions', () => {
  it('ends every session, drops the caches and writes one history row per fleet user', async () => {
    const held = new Map([
      ['usr_a', ['flt_gone', 'flt_kept']],
      ['usr_b', ['flt_gone']],
    ]);
    await endDeletedFleetUserSessions('flt_gone', held, actor, log);

    expect(h.endUserSessions.mock.calls).toEqual([
      ['usr_a', { apiKeys: false }],
      ['usr_b', { apiKeys: false }],
    ]);
    expect(h.invalidateSiteAccessCache.mock.calls).toEqual([['usr_a'], ['usr_b']]);
    expect(h.invalidatePermissionCache.mock.calls).toEqual([['usr_a'], ['usr_b']]);
    expect(h.writeAudit).toHaveBeenCalledTimes(2);
    expect(h.writeAudit).toHaveBeenCalledWith(
      { table: 'user_audit_log', idColumn: 'user_id' },
      expect.objectContaining({
        entityId: 'usr_a',
        action: 'updated',
        actor: 'operator',
        before: { fleetIds: ['flt_gone', 'flt_kept'] },
        after: { fleetIds: ['flt_kept'] },
      }),
      {},
      log,
    );
  });

  it('still writes the history row and goes on to the next user when ending a session fails', async () => {
    h.endUserSessions.mockRejectedValueOnce(new Error('redis down'));
    const held = new Map([
      ['usr_a', ['flt_gone']],
      ['usr_b', ['flt_gone']],
    ]);
    await endDeletedFleetUserSessions('flt_gone', held, actor, log);
    expect(h.endUserSessions).toHaveBeenCalledTimes(2);
    expect(h.writeAudit).toHaveBeenCalledTimes(2);
    expect((log as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledOnce();
  });
});
