// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { getAuditActor } from '../lib/audit-actor.js';

function makeRequest(user: unknown): { user: unknown } {
  return { user };
}

describe('getAuditActor', () => {
  it('returns operator with actorUserId for an operator JWT', () => {
    const req = makeRequest({ userId: 'usr_42', roleId: 'rol_admin' });
    const actor = getAuditActor(req as never);
    expect(actor).toEqual({
      actor: 'operator',
      actorUserId: 'usr_42',
      actorDriverId: null,
      actorApiKeyId: null,
      actorLabel: null,
    });
  });

  it('returns api_key when the JWT carries apiKeyId', () => {
    const req = makeRequest({ userId: 'usr_42', roleId: 'rol_admin', apiKeyId: 'key_abc' });
    const actor = getAuditActor(req as never);
    expect(actor).toEqual({
      actor: 'api_key',
      actorUserId: 'usr_42',
      actorDriverId: null,
      actorApiKeyId: 'key_abc',
      actorLabel: null,
    });
  });

  it('returns driver for a driver JWT', () => {
    const req = makeRequest({ driverId: 'drv_99', type: 'driver' });
    const actor = getAuditActor(req as never);
    expect(actor).toEqual({
      actor: 'driver',
      actorUserId: null,
      actorDriverId: 'drv_99',
      actorApiKeyId: null,
      actorLabel: null,
    });
  });

  it('falls back to system when there is no request.user', () => {
    const req = { user: undefined };
    const actor = getAuditActor(req as never);
    expect(actor.actor).toBe('system');
    expect(actor.actorUserId).toBeNull();
    expect(actor.actorDriverId).toBeNull();
  });

  it('keeps actorDriverId null when the driver JWT has no driverId field', () => {
    const req = makeRequest({ type: 'driver' });
    const actor = getAuditActor(req as never);
    expect(actor.actor).toBe('driver');
    expect(actor.actorDriverId).toBeNull();
  });
});
