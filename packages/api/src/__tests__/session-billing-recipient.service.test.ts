// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@evtivity/database', () => ({
  client: { name: 'client' },
  moveSessionBillingRecipient: vi.fn(),
  sessionAuditLog: { __table: 'session_audit_log' },
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

import { moveSessionBillingRecipient, writeAudit } from '@evtivity/database';
import {
  moveSessionsBilling,
  sessionBillingMoveError,
} from '../services/session-billing-recipient.service.js';

const actor = {
  actor: 'operator' as const,
  actorUserId: 'usr_1',
  actorDriverId: null,
  actorApiKeyId: null,
  actorLabel: null,
};
const log = { warn: vi.fn() } as never;

beforeEach(() => {
  vi.mocked(writeAudit).mockClear();
});

describe('moveSessionsBilling', () => {
  it('audits billing_reassigned with the recipient before and after for each moved session only', async () => {
    vi.mocked(moveSessionBillingRecipient).mockResolvedValueOnce([
      { sessionId: 'ses_1', outcome: 'moved', driverId: 'drv_1', fleetId: 'flt_1', from: 'fleet' },
      {
        sessionId: 'ses_2',
        outcome: 'unchanged',
        driverId: 'drv_1',
        fleetId: 'flt_1',
        from: 'member',
      },
      {
        sessionId: 'ses_3',
        outcome: 'invoiced',
        driverId: 'drv_1',
        fleetId: 'flt_1',
        from: 'fleet',
      },
    ]);
    const moves = await moveSessionsBilling(['ses_1', 'ses_2', 'ses_3'], 'member', { actor, log });
    expect(moves).toHaveLength(3);
    expect(moveSessionBillingRecipient).toHaveBeenCalledWith(
      { name: 'client' },
      ['ses_1', 'ses_2', 'ses_3'],
      'member',
    );
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledWith(
      { table: { __table: 'session_audit_log' }, idColumn: 'session_id' },
      expect.objectContaining({
        entityId: 'ses_1',
        action: 'billing_reassigned',
        actor: 'operator',
        actorUserId: 'usr_1',
        before: { recipient: 'fleet', memberBilled: false },
        after: { recipient: 'member', memberBilled: true, fleetId: 'flt_1', driverId: 'drv_1' },
      }),
      undefined,
      log,
    );
  });
});

describe('sessionBillingMoveError', () => {
  it('maps each refusal to its code and status', () => {
    expect(sessionBillingMoveError('moved')).toBeNull();
    expect(sessionBillingMoveError('unchanged')).toBeNull();
    const cases = [
      ['not_found', 404, 'SESSION_NOT_FOUND'],
      ['not_on_account', 409, 'SESSION_NOT_ON_ACCOUNT'],
      ['invoiced', 409, 'SESSION_ALREADY_INVOICED'],
      ['billing_off', 409, 'FLEET_ACCOUNT_BILLING_OFF'],
      ['not_member', 409, 'DRIVER_NOT_FLEET_MEMBER'],
    ] as const;
    for (const [outcome, status, code] of cases) {
      expect(sessionBillingMoveError(outcome)).toMatchObject({ statusCode: status, code });
    }
  });
});
