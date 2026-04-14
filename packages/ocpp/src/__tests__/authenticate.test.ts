// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { hash } from 'argon2';
import { authenticateConnection, extractStationId } from '../server/middleware/authenticate.js';

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'debug',
    silent: vi.fn(),
    isLevelEnabled: vi.fn().mockReturnValue(true),
  } as unknown as Parameters<typeof authenticateConnection>[1];
}

function createMockRequest(url: string, authHeader?: string, encrypted = false): IncomingMessage {
  const socket = {
    remoteAddress: '127.0.0.1',
    encrypted,
  } as unknown as Socket;

  const req = {
    url,
    headers: {} as Record<string, string>,
    socket,
  } as unknown as IncomingMessage;

  if (authHeader != null) {
    req.headers['authorization'] = authHeader;
  }

  return req;
}

function createMockTlsRequest(
  url: string,
  options: {
    authorized: boolean;
    hasCert: boolean;
    authorizationError?: string;
    cn?: string;
    authHeader?: string;
  },
): IncomingMessage {
  const peerCert = options.hasCert
    ? { subject: { CN: options.cn ?? 'Test Client' }, issuer: { CN: 'Test CA' } }
    : {};

  const socket = {
    remoteAddress: '127.0.0.1',
    encrypted: true,
    authorized: options.authorized,
    authorizationError: options.authorizationError,
    getPeerCertificate: vi.fn().mockReturnValue(peerCert),
  };

  const req = {
    url,
    headers: {} as Record<string, string>,
    socket,
  } as unknown as IncomingMessage;

  if (options.authHeader != null) {
    req.headers['authorization'] = options.authHeader;
  }

  return req;
}

function createMockSql(rows: unknown[]) {
  const sql = vi.fn().mockResolvedValue(rows);
  // Mock the tagged template literal interface
  return new Proxy(sql, {
    apply() {
      return Promise.resolve(rows) as unknown;
    },
    get(target, prop) {
      if (prop === 'then') return undefined; // not a promise
      return target[prop as keyof typeof target];
    },
  }) as unknown as Parameters<typeof authenticateConnection>[2];
}

describe('extractStationId', () => {
  it('extracts station ID from valid URL', () => {
    expect(extractStationId('/STATION-001')).toBe('STATION-001');
  });

  it('returns null for missing URL', () => {
    expect(extractStationId(undefined)).toBeNull();
  });

  it('returns null for nested path', () => {
    expect(extractStationId('/ocpp/STATION-001')).toBeNull();
  });
});

describe('authenticateConnection', () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('rejects missing station ID', async () => {
    const req = createMockRequest('/nested/path');
    const result = await authenticateConnection(req, logger, null);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Missing station ID in URL');
  });

  it('accepts connection without DB (permissive mode)', async () => {
    const req = createMockRequest('/TEST-01');
    const result = await authenticateConnection(req, logger, null);
    expect(result.authenticated).toBe(true);
    expect(result.stationId).toBe('TEST-01');
    expect(result.stationDbId).toBeNull();
  });

  it('rejects unknown station', async () => {
    const sql = createMockSql([]);
    const req = createMockRequest('/UNKNOWN');
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Unknown station');
  });

  it('rejects blocked station', async () => {
    const sql = createMockSql([
      {
        id: 'db-id-blocked',
        security_profile: 0,
        basic_auth_password_hash: null,
        onboarding_status: 'blocked',
      },
    ]);
    const req = createMockRequest('/BLOCKED-STATION');
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(false);
    expect(result.stationDbId).toBe('db-id-blocked');
    expect(result.error).toBe('Station is blocked');
  });

  it('accepts pending station', async () => {
    const sql = createMockSql([
      {
        id: 'db-id-pending',
        security_profile: 0,
        basic_auth_password_hash: null,
        onboarding_status: 'pending',
      },
    ]);
    const req = createMockRequest('/PENDING-STATION');
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(true);
    expect(result.stationDbId).toBe('db-id-pending');
  });

  it('accepts SP0 station without credentials', async () => {
    const sql = createMockSql([
      {
        id: 'db-id-1',
        security_profile: 0,
        basic_auth_password_hash: null,
        onboarding_status: 'accepted',
      },
    ]);
    const req = createMockRequest('/SP0-STATION');
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(true);
    expect(result.stationDbId).toBe('db-id-1');
  });

  it('rejects SP1 station without credentials', async () => {
    const passwordHash = await hash('testpass');
    const sql = createMockSql([
      {
        id: 'db-id-2',
        security_profile: 1,
        basic_auth_password_hash: passwordHash,
        onboarding_status: 'accepted',
      },
    ]);
    const req = createMockRequest('/SP1-STATION');
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Basic auth credentials required');
  });

  it('rejects SP1 station with wrong password', async () => {
    const passwordHash = await hash('correctpass');
    const sql = createMockSql([
      {
        id: 'db-id-3',
        security_profile: 1,
        basic_auth_password_hash: passwordHash,
        onboarding_status: 'accepted',
      },
    ]);
    const authHeader = 'Basic ' + Buffer.from('station:wrongpass').toString('base64');
    const req = createMockRequest('/SP1-STATION', authHeader);
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Invalid credentials');
  });

  it('accepts SP1 station with correct password', async () => {
    const passwordHash = await hash('correctpass');
    const sql = createMockSql([
      {
        id: 'db-id-4',
        security_profile: 1,
        basic_auth_password_hash: passwordHash,
        onboarding_status: 'accepted',
      },
    ]);
    const authHeader = 'Basic ' + Buffer.from('station:correctpass').toString('base64');
    const req = createMockRequest('/SP1-STATION', authHeader);
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(true);
    expect(result.stationDbId).toBe('db-id-4');
  });

  it('rejects SP2 station on non-TLS connection', async () => {
    const passwordHash = await hash('testpass');
    const sql = createMockSql([
      {
        id: 'db-id-5',
        security_profile: 2,
        basic_auth_password_hash: passwordHash,
        onboarding_status: 'accepted',
      },
    ]);
    const authHeader = 'Basic ' + Buffer.from('station:testpass').toString('base64');
    const req = createMockRequest('/SP2-STATION', authHeader, false);
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Security Profile 2 requires TLS');
  });

  it('rejects SP1 station with no password configured', async () => {
    const sql = createMockSql([
      {
        id: 'db-id-6',
        security_profile: 1,
        basic_auth_password_hash: null,
        onboarding_status: 'accepted',
      },
    ]);
    const authHeader = 'Basic ' + Buffer.from('station:somepass').toString('base64');
    const req = createMockRequest('/SP1-NO-PASS', authHeader);
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('No password configured for station');
  });

  it('rejects invalid auth scheme', async () => {
    const sql = createMockSql([
      {
        id: 'db-id-7',
        security_profile: 1,
        basic_auth_password_hash: 'somehash',
        onboarding_status: 'accepted',
      },
    ]);
    const req = createMockRequest('/SP1-STATION', 'Bearer token123');
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Invalid auth scheme');
  });

  // SP3 tests
  it('accepts SP3 station with valid client certificate', async () => {
    const sql = createMockSql([
      {
        id: 'db-id-sp3',
        security_profile: 3,
        basic_auth_password_hash: null,
        onboarding_status: 'accepted',
      },
    ]);
    const req = createMockTlsRequest('/SP3-STATION', {
      authorized: true,
      hasCert: true,
      cn: 'SP3-STATION',
    });
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(true);
    expect(result.stationDbId).toBe('db-id-sp3');
  });

  it('rejects SP3 station without client certificate', async () => {
    const sql = createMockSql([
      {
        id: 'db-id-sp3-2',
        security_profile: 3,
        basic_auth_password_hash: null,
        onboarding_status: 'accepted',
      },
    ]);
    const req = createMockTlsRequest('/SP3-NO-CERT', {
      authorized: false,
      hasCert: false,
    });
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Client certificate required for SP3');
  });

  it('rejects SP3 station with untrusted certificate', async () => {
    const sql = createMockSql([
      {
        id: 'db-id-sp3-3',
        security_profile: 3,
        basic_auth_password_hash: null,
        onboarding_status: 'accepted',
      },
    ]);
    const req = createMockTlsRequest('/SP3-UNTRUSTED', {
      authorized: false,
      hasCert: true,
      authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN',
    });
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Client certificate not trusted');
  });

  it('rejects SP3 station on non-TLS connection', async () => {
    const sql = createMockSql([
      {
        id: 'db-id-sp3-4',
        security_profile: 3,
        basic_auth_password_hash: null,
        onboarding_status: 'accepted',
      },
    ]);
    const req = createMockRequest('/SP3-NO-TLS', undefined, false);
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('SP3 requires TLS');
  });
});
