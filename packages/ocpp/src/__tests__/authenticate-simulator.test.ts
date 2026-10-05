// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { hash } from 'argon2';

const reconcileMock = vi.fn();
vi.mock('../server/middleware/simulator-identity.js', async (importActual) => {
  const actual = await importActual<typeof import('../server/middleware/simulator-identity.js')>();
  return {
    ...actual,
    reconcileSimulatorIdentity: (...args: unknown[]) => reconcileMock(...args) as unknown,
  };
});

import { authenticateConnection } from '../server/middleware/authenticate.js';

const PASSWORD = 'abcdefghij0123456789';
let passwordHash = '';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<typeof authenticateConnection>[1];

function request(stationId: string, opts: { password?: string; marker?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (opts.password != null) {
    headers['authorization'] =
      'Basic ' + Buffer.from(`${stationId}:${opts.password}`).toString('base64');
  }
  if (opts.marker === true) headers['x-evtivity-simulator'] = 'css';
  return {
    url: `/${stationId}`,
    headers,
    socket: { remoteAddress: '10.0.0.9', encrypted: false },
  } as unknown as IncomingMessage;
}

function stationSql(station: Record<string, unknown>) {
  const proxy = new Proxy(vi.fn(), {
    apply(_t, _this, args: unknown[]) {
      const [strings] = args as [TemplateStringsArray];
      return Promise.resolve(strings.join('?').includes('FROM charging_stations') ? [station] : []);
    },
    get(target, prop) {
      if (prop === 'then') return undefined;
      if (prop === 'json') return (v: unknown) => v;
      return target[prop as keyof typeof target];
    },
  });
  return proxy as unknown as Parameters<typeof authenticateConnection>[2];
}

describe('authenticateConnection on a simulator-flagged station', () => {
  beforeAll(async () => {
    passwordHash = await hash(PASSWORD);
  });

  beforeEach(() => {
    reconcileMock.mockReset();
  });

  const flagged = (overrides: Record<string, unknown> = {}) => ({
    id: 'sta_sim',
    security_profile: 1,
    pending_security_profile: null,
    basic_auth_password_hash: passwordHash,
    onboarding_status: 'accepted',
    is_simulator: true,
    css_enabled: true,
    css_marker_seen_at: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  });

  it('passes an authenticated connection without the marker to the identity check', async () => {
    const result = await authenticateConnection(
      request('CS-SIM', { password: PASSWORD }),
      logger,
      stationSql(flagged()),
      '10.0.0.9',
    );
    expect(result.authenticated).toBe(true);
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect(reconcileMock.mock.calls[0]?.[1]).toEqual({
      stationDbId: 'sta_sim',
      stationId: 'CS-SIM',
      securityProfile: 1,
      markerPresent: false,
      pairing: { enabled: true, markerSeenAt: new Date('2026-10-01T00:00:00Z') },
      remoteAddress: '10.0.0.9',
    });
  });

  it('reports the marker and a missing pairing', async () => {
    await authenticateConnection(
      request('CS-SIM', { password: PASSWORD, marker: true }),
      logger,
      stationSql(flagged({ css_enabled: null, css_marker_seen_at: null })),
    );
    expect(reconcileMock.mock.calls[0]?.[1]).toMatchObject({ markerPresent: true, pairing: null });
  });

  it('reports the pending profile the station authenticated with', async () => {
    await authenticateConnection(
      request('CS-SIM', { password: PASSWORD }),
      logger,
      stationSql(flagged({ security_profile: 0, pending_security_profile: 1 })),
    );
    expect(reconcileMock.mock.calls[0]?.[1]).toMatchObject({ securityProfile: 1 });
  });

  it('skips the check for a rejected connection', async () => {
    const result = await authenticateConnection(
      request('CS-SIM', { password: 'wrong-password-000000' }),
      logger,
      stationSql(flagged()),
    );
    expect(result.authenticated).toBe(false);
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it('skips the check for a station that is not flagged', async () => {
    await authenticateConnection(
      request('CS-SIM', { password: PASSWORD }),
      logger,
      stationSql(flagged({ is_simulator: false })),
    );
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});
