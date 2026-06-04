// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

vi.mock('argon2', async (importActual) => {
  const actual = await importActual<typeof import('argon2')>();
  return {
    ...actual,
    verify: vi.fn(actual.verify),
  };
});

import { hash, verify } from 'argon2';
import { authenticateConnection, extractStationId } from '../server/middleware/authenticate.js';

const verifyMock = verify as unknown as ReturnType<typeof vi.fn>;

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

function createMockRequest(
  url: string,
  authHeader?: string,
  encrypted = false,
  remoteAddress: string | undefined = '127.0.0.1',
): IncomingMessage {
  const socket = {
    remoteAddress,
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
    serialNumber?: string;
  },
): IncomingMessage {
  const peerCert = options.hasCert
    ? {
        subject: { CN: options.cn ?? 'Test Client' },
        issuer: { CN: 'Test CA' },
        serialNumber: options.serialNumber ?? 'ABCDEF0123456789',
      }
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

interface QueueSqlOptions {
  // Resolved value per tagged-template invocation, in call order.
  results: unknown[][];
  // When true, sql.json throws and INSERTs (which use sql.json) reject,
  // exercising the logAuthEvent best-effort catch block.
  failJson?: boolean;
}

/**
 * SQL mock that returns a different result set per invocation so we can
 * exercise the SP3 station-lookup-then-certificate-lookup sequence and the
 * connection_logs INSERT path independently. Calls beyond the supplied list
 * resolve to [].
 */
function createQueuedSql(opts: QueueSqlOptions) {
  const queue = [...opts.results];
  const calls: { json: number; query: number } = { json: 0, query: 0 };
  const sql = vi.fn();
  const json = vi.fn((value: unknown) => {
    calls.json++;
    if (opts.failJson === true) {
      throw new Error('sql.json failed');
    }
    return value;
  });
  const proxy = new Proxy(sql, {
    apply() {
      calls.query++;
      const next = queue.shift() ?? [];
      return Promise.resolve(next) as unknown;
    },
    get(target, prop) {
      if (prop === 'then') return undefined;
      if (prop === 'json') return json;
      if (prop === '__calls') return calls;
      return target[prop as keyof typeof target];
    },
  });
  return proxy as unknown as Parameters<typeof authenticateConnection>[2];
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
    const authHeader = 'Basic ' + Buffer.from('SP1-STATION:wrongpass').toString('base64');
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
    const authHeader = 'Basic ' + Buffer.from('SP1-STATION:correctpass').toString('base64');
    const req = createMockRequest('/SP1-STATION', authHeader);
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(true);
    expect(result.stationDbId).toBe('db-id-4');
  });

  it('rejects SP1 station when Basic auth username does not equal ChargingStationId', async () => {
    const passwordHash = await hash('correctpass');
    const sql = createMockSql([
      {
        id: 'db-id-4b',
        security_profile: 1,
        basic_auth_password_hash: passwordHash,
        onboarding_status: 'accepted',
      },
    ]);
    const authHeader = 'Basic ' + Buffer.from('OTHER-STATION:correctpass').toString('base64');
    const req = createMockRequest('/SP1-STATION', authHeader);
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Username must equal the ChargingStationId');
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
    const authHeader = 'Basic ' + Buffer.from('SP1-NO-PASS:somepass').toString('base64');
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

  it('rejects SP3 station whose certificate has no serial number', async () => {
    const station = {
      id: 'db-id-sp3-noserial',
      security_profile: 3,
      basic_auth_password_hash: null,
      onboarding_status: 'accepted',
    };
    const sql = createQueuedSql({ results: [[station]] });
    const req = createMockTlsRequest('/SP3-NO-SERIAL', {
      authorized: true,
      hasCert: true,
      cn: 'SP3-NO-SERIAL',
    });
    // Strip the serialNumber from the cert returned by getPeerCertificate.
    const sock = req.socket as unknown as {
      getPeerCertificate: () => Record<string, unknown>;
    };
    const cert = sock.getPeerCertificate();
    delete cert['serialNumber'];
    (sock.getPeerCertificate as ReturnType<typeof vi.fn>) = vi.fn().mockReturnValue(cert);

    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(false);
    expect(result.stationDbId).toBe('db-id-sp3-noserial');
    expect(result.error).toBe('Client certificate missing serial number');
  });

  it('rejects SP3 station whose certificate serial is an empty string', async () => {
    const station = {
      id: 'db-id-sp3-emptyserial',
      security_profile: 3,
      basic_auth_password_hash: null,
      onboarding_status: 'accepted',
    };
    const sql = createQueuedSql({ results: [[station]] });
    const req = createMockTlsRequest('/SP3-EMPTY-SERIAL', {
      authorized: true,
      hasCert: true,
      cn: 'SP3-EMPTY-SERIAL',
      serialNumber: '',
    });
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Client certificate missing serial number');
  });

  it('rejects SP3 station whose certificate serial is not registered for it', async () => {
    const station = {
      id: 'db-id-sp3-unreg',
      security_profile: 3,
      basic_auth_password_hash: null,
      onboarding_status: 'accepted',
    };
    // First query: station lookup -> the station. Second query: certificate
    // serial lookup -> empty (serial not registered for this station).
    const sql = createQueuedSql({ results: [[station], []] });
    const req = createMockTlsRequest('/SP3-UNREG', {
      authorized: true,
      hasCert: true,
      cn: 'SP3-UNREG',
      serialNumber: 'DEADBEEF01',
    });
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(false);
    expect(result.stationDbId).toBe('db-id-sp3-unreg');
    expect(result.error).toBe('Client certificate not registered for this station');
  });

  it('accepts SP3 station whose certificate serial is registered', async () => {
    const station = {
      id: 'db-id-sp3-reg',
      security_profile: 3,
      basic_auth_password_hash: null,
      onboarding_status: 'accepted',
    };
    // Station lookup, then certificate lookup returns a matching row.
    const sql = createQueuedSql({ results: [[station], [{ id: 'cert-1' }]] });
    const req = createMockTlsRequest('/SP3-REG', {
      authorized: true,
      hasCert: true,
      cn: 'SP3-REG',
      serialNumber: 'ABCDEF0123456789',
    });
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(true);
    expect(result.stationDbId).toBe('db-id-sp3-reg');
  });

  it('accepts SP2 station on TLS connection with valid Basic auth', async () => {
    const passwordHash = await hash('sp2pass');
    const station = {
      id: 'db-id-sp2-ok',
      security_profile: 2,
      basic_auth_password_hash: passwordHash,
      onboarding_status: 'accepted',
    };
    const sql = createQueuedSql({ results: [[station]] });
    const authHeader = 'Basic ' + Buffer.from('SP2-OK:sp2pass').toString('base64');
    const req = createMockTlsRequest('/SP2-OK', {
      authorized: true,
      hasCert: false,
      authHeader,
    });
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(true);
    expect(result.stationDbId).toBe('db-id-sp2-ok');
  });

  it('returns authentication error when argon2 verify throws an Error', async () => {
    // A malformed password hash makes argon2.verify reject, exercising the
    // catch block that returns the generic "Authentication error".
    const station = {
      id: 'db-id-verify-throw',
      security_profile: 1,
      basic_auth_password_hash: 'not-a-valid-argon2-hash',
      onboarding_status: 'accepted',
    };
    const sql = createQueuedSql({ results: [[station]] });
    const authHeader = 'Basic ' + Buffer.from('VERIFY-THROW:anything').toString('base64');
    const req = createMockRequest('/VERIFY-THROW', authHeader);
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(false);
    expect(result.stationDbId).toBe('db-id-verify-throw');
    expect(result.error).toBe('Authentication error');
    expect(logger.error).toHaveBeenCalled();
  });

  it('returns authentication error when argon2 verify rejects with a non-Error', async () => {
    verifyMock.mockRejectedValueOnce('string failure');
    const station = {
      id: 'db-id-verify-nonerror',
      security_profile: 1,
      basic_auth_password_hash: await hash('correct'),
      onboarding_status: 'accepted',
    };
    const sql = createQueuedSql({ results: [[station]] });
    const authHeader = 'Basic ' + Buffer.from('VERIFY-NONERR:correct').toString('base64');
    const req = createMockRequest('/VERIFY-NONERR', authHeader);
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Authentication error');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'string failure' }),
      'Password verification error',
    );
  });

  it('rejects connection and surfaces no DB in production mode', async () => {
    const prev = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      const req = createMockRequest('/PROD-NO-DB');
      const result = await authenticateConnection(req, logger, null);
      expect(result.authenticated).toBe(false);
      expect(result.error).toBe('Database unavailable');
      expect(result.stationId).toBe('PROD-NO-DB');
      expect(logger.error).toHaveBeenCalled();
    } finally {
      process.env['NODE_ENV'] = prev;
    }
  });

  it('treats a no-colon Basic auth header as username-only with empty password', async () => {
    // When the decoded credential has no colon, username is the whole string
    // and password is empty. With username !== stationId this rejects on the
    // identity check, covering the no-colon ternary branch.
    const station = {
      id: 'db-id-no-colon',
      security_profile: 1,
      basic_auth_password_hash: await hash('whatever'),
      onboarding_status: 'accepted',
    };
    const sql = createQueuedSql({ results: [[station]] });
    const authHeader = 'Basic ' + Buffer.from('NO-COLON-CRED').toString('base64');
    const req = createMockRequest('/NO-COLON', authHeader);
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Username must equal the ChargingStationId');
  });

  it('handles a missing remote address when logging an auth failure', async () => {
    const station = {
      id: 'db-id-no-addr',
      security_profile: 1,
      basic_auth_password_hash: await hash('x'),
      onboarding_status: 'accepted',
    };
    const sql = createQueuedSql({ results: [[station]] });
    const req = createMockRequest('/NO-ADDR', undefined, false, undefined);
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Basic auth credentials required');
  });

  it('continues past a connection_logs INSERT failure and still rejects', async () => {
    // SP1 station missing credentials triggers a logAuthEvent INSERT. When the
    // INSERT (via sql.json) throws, the auth flow must still return its
    // rejection rather than propagating the logging failure.
    const station = {
      id: 'db-id-log-fail',
      security_profile: 1,
      basic_auth_password_hash: await hash('x'),
      onboarding_status: 'accepted',
    };
    const sql = createQueuedSql({ results: [[station]], failJson: true });
    const req = createMockRequest('/LOG-FAIL');
    const result = await authenticateConnection(req, logger, sql);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Basic auth credentials required');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'auth_failed', stationDbId: 'db-id-log-fail' }),
      'Failed to write connection_logs row',
    );
  });
});
