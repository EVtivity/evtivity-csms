// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest } from 'fastify';

vi.mock('@evtivity/database', () => ({
  db: { insert: vi.fn() },
  writeAudit: vi.fn(() => Promise.resolve()),
  userAuditLog: { _table: 'user_audit_log' },
  driverAuditLog: { _table: 'driver_audit_log' },
  stationAuditLog: { _table: 'station_audit_log' },
}));

import { writeAudit, userAuditLog, driverAuditLog, stationAuditLog } from '@evtivity/database';
import { authRequestOrigin, recordAuthAudit } from '../lib/auth-audit.js';
import { commandOutcome, recordStationCommandAudit } from '../lib/station-command-audit.js';
import {
  AUTH_FAILURE_METHODS,
  AUTH_FAILURE_REASONS,
  authFailuresTotal,
  countAuthFailure,
} from '../plugins/metrics.js';

function request(headers: Record<string, string> = {}): FastifyRequest {
  return { ip: '10.0.0.7', headers, log: { warn: vi.fn() } } as unknown as FastifyRequest;
}

function lastArgs(): [{ table: unknown; idColumn: string }, Record<string, unknown>] {
  const call = vi.mocked(writeAudit).mock.calls.at(-1);
  if (call == null) throw new Error('writeAudit not called');
  return [call[0], call[1] as unknown as Record<string, unknown>];
}

describe('authRequestOrigin', () => {
  it('records the IP and a bounded user agent', () => {
    const origin = authRequestOrigin(request({ 'user-agent': 'x'.repeat(400) }));
    expect(origin.ip).toBe('10.0.0.7');
    expect(origin.userAgent).toHaveLength(255);
  });

  it('records a null user agent when none is sent', () => {
    expect(authRequestOrigin(request()).userAgent).toBeNull();
  });
});

describe('recordAuthAudit', () => {
  beforeEach(() => {
    vi.mocked(writeAudit).mockClear();
  });

  it('records an operator login on the user as its own actor', async () => {
    await recordAuthAudit(request({ 'user-agent': 'ua' }), {
      kind: 'user',
      accountId: 'usr_1',
      action: 'login_succeeded',
      method: 'password',
    });
    const [config, args] = lastArgs();
    expect(config).toEqual({ table: userAuditLog, idColumn: 'user_id' });
    expect(args).toMatchObject({
      entityId: 'usr_1',
      entityIdSnapshot: 'usr_1',
      action: 'login_succeeded',
      actor: 'operator',
      actorUserId: 'usr_1',
      after: { method: 'password', ip: '10.0.0.7', userAgent: 'ua' },
      notes: null,
    });
  });

  it('records a failed login as system labelled login, with the reason', async () => {
    await recordAuthAudit(request(), {
      kind: 'driver',
      accountId: 'drv_1',
      action: 'login_failed',
      method: 'mfa',
      reason: 'mfa_code_invalid',
    });
    const [config, args] = lastArgs();
    expect(config).toEqual({ table: driverAuditLog, idColumn: 'driver_id' });
    expect(args).toMatchObject({
      entityId: 'drv_1',
      action: 'login_failed',
      actor: 'system',
      actorLabel: 'login',
      notes: 'mfa_code_invalid',
    });
    expect(args['actorDriverId']).toBeUndefined();
  });

  it('records a driver email verification with the driver as actor', async () => {
    await recordAuthAudit(request(), {
      kind: 'driver',
      accountId: 'drv_2',
      action: 'email_verified',
      method: 'verification_token',
    });
    expect(lastArgs()[1]).toMatchObject({ actor: 'driver', actorDriverId: 'drv_2' });
  });
});

describe('recordStationCommandAudit', () => {
  beforeEach(() => {
    vi.mocked(writeAudit).mockClear();
  });

  it('writes command_dispatched with the command, session and outcome only', async () => {
    await recordStationCommandAudit({
      stationId: 'sta_1',
      actor: { actor: 'driver', actorDriverId: 'drv_1' },
      command: 'RequestStartTransaction',
      sessionId: 'ses_1',
      evseId: 2,
      outcome: 'Accepted',
    });
    const [config, args] = lastArgs();
    expect(config).toEqual({ table: stationAuditLog, idColumn: 'station_id' });
    expect(args).toMatchObject({
      entityId: 'sta_1',
      action: 'command_dispatched',
      actor: 'driver',
      actorDriverId: 'drv_1',
      notes: 'RequestStartTransaction (Accepted)',
      after: {
        action: 'RequestStartTransaction',
        sessionId: 'ses_1',
        evseId: 2,
        outcome: 'Accepted',
      },
    });
  });

  it('reads the outcome of an answered or failed command', () => {
    expect(commandOutcome({ response: { status: 'Rejected' } })).toBe('Rejected');
    expect(commandOutcome({ error: 'timeout' })).toBe('error');
    expect(commandOutcome({ response: {} })).toBe('Unknown');
  });
});

describe('auth_failures_total', () => {
  async function count(labels: Record<string, string>): Promise<number> {
    const { values } = await authFailuresTotal.get();
    return values
      .filter((v) =>
        Object.entries(labels).every(
          ([k, val]) => (v.labels as Record<string, string | number | undefined>)[k] === val,
        ),
      )
      .reduce((sum, v) => sum + v.value, 0);
  }

  beforeEach(() => {
    authFailuresTotal.reset();
  });

  it('counts a failed operator and driver sign-in with its method and reason', async () => {
    await recordAuthAudit(request(), {
      kind: 'user',
      accountId: 'usr_1',
      action: 'login_failed',
      method: 'password',
      reason: 'bad_password',
    });
    await recordAuthAudit(request(), {
      kind: 'driver',
      accountId: null,
      action: 'login_failed',
      method: 'passkey',
      reason: 'webauthn_unknown_credential',
    });
    expect(await count({ realm: 'operator', method: 'password', reason: 'bad_password' })).toBe(1);
    expect(
      await count({ realm: 'driver', method: 'passkey', reason: 'webauthn_unknown_credential' }),
    ).toBe(1);
  });

  it('counts a failure without a reason as unknown and never counts a success', async () => {
    await recordAuthAudit(request(), {
      kind: 'driver',
      accountId: 'drv_1',
      action: 'login_failed',
      method: 'mfa',
    });
    await recordAuthAudit(request(), {
      kind: 'user',
      accountId: 'usr_1',
      action: 'login_succeeded',
      method: 'password',
    });
    expect(await count({ realm: 'driver', method: 'mfa', reason: 'unknown' })).toBe(1);
    expect(await count({})).toBe(1);
  });

  it('takes method and reason labels only from the fixed lists', async () => {
    expect(new Set(AUTH_FAILURE_METHODS).size).toBe(AUTH_FAILURE_METHODS.length);
    expect(new Set(AUTH_FAILURE_REASONS).size).toBe(AUTH_FAILURE_REASONS.length);
    for (const value of [...AUTH_FAILURE_METHODS, ...AUTH_FAILURE_REASONS]) {
      expect(value).toMatch(/^[a-z][a-z_]*$/);
    }
    // Free text is a type error (npm run typecheck covers this file), so no caller
    // can put request text in a label. Never called: the type check is the test.
    const freeText = async (): Promise<void> => {
      // @ts-expect-error method is a fixed union
      countAuthFailure('operator', 'Bearer abc', 'bad_password');
      // @ts-expect-error reason is a fixed union
      countAuthFailure('operator', 'password', 'user@example.com');
      await recordAuthAudit(request(), {
        kind: 'user',
        accountId: 'usr_1',
        action: 'login_failed',
        method: 'password',
        // @ts-expect-error the audit reason is the same fixed union
        reason: 'anything the request said',
      });
    };
    expect(freeText).toBeTypeOf('function');
    countAuthFailure('operator', 'api_key', 'api_key_expired');
    const { values } = await authFailuresTotal.get();
    expect(values.map((v) => v.labels)).toEqual([
      { realm: 'operator', method: 'api_key', reason: 'api_key_expired' },
    ]);
  });

  it('counts directly for failures that write no audit row', async () => {
    countAuthFailure('operator', 'api_key', 'api_key_invalid');
    expect(await count({ realm: 'operator', method: 'api_key', reason: 'api_key_invalid' })).toBe(
      1,
    );
  });
});
