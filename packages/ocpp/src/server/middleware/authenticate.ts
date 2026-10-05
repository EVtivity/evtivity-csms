// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { IncomingMessage } from 'node:http';
import type postgres from 'postgres';
import { verify } from 'argon2';
import type { Logger } from '@evtivity/lib';
import { logConnectionEvent } from './connection-log.js';
import { hasSimulatorMarker, reconcileSimulatorIdentity } from './simulator-identity.js';

export type AuthFailure =
  | 'unknown_station'
  | 'blocked'
  | 'tls_required'
  | 'client_certificate'
  | 'credentials'
  | 'unavailable';

export interface AuthResult {
  authenticated: boolean;
  stationId: string | null;
  stationDbId: string | null;
  error?: string | undefined;
  failure?: AuthFailure | undefined;
}

export interface AuthRejection {
  status: number;
  message: string;
  headers?: Record<string, string>;
}

// HTTP response for a rejected WebSocket upgrade. Stations that send Basic
// auth only after a challenge (RFC 7617) need 401 with WWW-Authenticate; a
// challenge is only offered where Basic auth applies and the transport is
// acceptable (SP1, or SP2 over TLS). OCPP-J 1.6 recommends 404 for an unknown
// charge point identity.
export function rejectionFor(auth: AuthResult): AuthRejection {
  switch (auth.failure) {
    case 'credentials':
      return {
        status: 401,
        message: 'Unauthorized',
        headers: { 'WWW-Authenticate': 'Basic realm="OCPP", charset="UTF-8"' },
      };
    case 'tls_required':
    case 'client_certificate':
      return { status: 401, message: 'Unauthorized' };
    case 'unknown_station':
      return { status: 404, message: 'Not Found' };
    case 'blocked':
      return { status: 403, message: 'Forbidden' };
    case 'unavailable':
    case undefined:
      return serviceUnavailable();
  }
}

// A refused upgrade during a reconnect wave or a database outage. Retry-After
// (RFC 9110) tells a station that honors it when to come back; the jitter
// spreads those retries instead of returning the whole wave at once.
export const RETRY_AFTER_BASE_SECONDS = 10;
export const RETRY_AFTER_JITTER_SECONDS = 10;

export function serviceUnavailable(random: () => number = Math.random): AuthRejection {
  const seconds =
    RETRY_AFTER_BASE_SECONDS + Math.floor(random() * (RETRY_AFTER_JITTER_SECONDS + 1));
  return {
    status: 503,
    message: 'Service Unavailable',
    headers: { 'Retry-After': String(seconds) },
  };
}

export function extractStationId(url: string | undefined): string | null {
  if (url == null) return null;

  // OCPP WebSocket URL format: /<stationId>
  const match = /^\/([A-Za-z0-9_\-:.]{1,128})$/.exec(url);
  return match?.[1] ?? null;
}

export async function authenticateConnection(
  req: IncomingMessage,
  logger: Logger,
  sql: postgres.Sql | null,
  clientIp: string | null = req.socket.remoteAddress ?? null,
  viaTls: boolean = 'encrypted' in req.socket && req.socket.encrypted === true,
): Promise<AuthResult> {
  const stationId = extractStationId(req.url);
  if (stationId == null) {
    return {
      authenticated: false,
      stationId: null,
      stationDbId: null,
      error: 'Missing station ID in URL',
      failure: 'unknown_station',
    };
  }

  // Without a database connection, reject in production, allow in test
  if (sql == null) {
    if (process.env['NODE_ENV'] === 'test') {
      logger.warn({ stationId }, 'No database connection; skipping auth validation (test mode)');
      return { authenticated: true, stationId, stationDbId: null };
    }
    logger.error({ stationId }, 'No database connection; rejecting connection');
    return {
      authenticated: false,
      stationId,
      stationDbId: null,
      error: 'Database unavailable',
      failure: 'unavailable',
    };
  }

  // Look up station in database
  // The paired simulator row (if any) rides along so a simulator-flagged
  // station needs no second lookup (see simulator-identity.ts).
  const rows = await sql`
    SELECT cs.id, cs.security_profile, cs.pending_security_profile, cs.basic_auth_password_hash,
           cs.availability, cs.onboarding_status, cs.is_simulator,
           css.enabled AS css_enabled, css.marker_seen_at AS css_marker_seen_at
    FROM charging_stations cs
    LEFT JOIN css_stations css ON css.station_id = cs.station_id
    WHERE cs.station_id = ${stationId}
  `;
  const station = rows[0] as
    | {
        id: string;
        security_profile: number;
        pending_security_profile: number | null;
        basic_auth_password_hash: string | null;
        availability: string;
        onboarding_status: string;
        is_simulator?: boolean | null;
        css_enabled?: boolean | null;
        css_marker_seen_at?: Date | null;
      }
    | undefined;

  if (station == null) {
    logger.warn({ stationId }, 'Connection rejected: unknown station');
    return {
      authenticated: false,
      stationId,
      stationDbId: null,
      error: 'Unknown station',
      failure: 'unknown_station',
    };
  }

  if (station.onboarding_status === 'blocked') {
    logger.warn({ stationId }, 'Connection rejected: station is blocked');
    return {
      authenticated: false,
      stationId,
      stationDbId: station.id,
      error: 'Station is blocked',
      failure: 'blocked',
    };
  }

  // Pending stations are allowed to connect so operators can send OCPP commands
  // during onboarding. Charging is blocked at the API level instead.
  // Blocked stations are rejected here at the connection level.

  const remoteAddress = clientIp;
  const ctx = { req, sql, logger, stationId, station, remoteAddress, viaTls };

  // An upgrade sent to the station is pending until the station connects with
  // the new profile. Try it first; on success promote it, after which the old
  // profile is no longer accepted (OCPP 2.1 A05.FR.07). Its failures are not
  // logged: until the station switches, every connection fails this check.
  const pending = station.pending_security_profile;
  let result: AuthResult | null = null;
  let usedProfile = station.security_profile;
  if (pending != null && pending !== station.security_profile) {
    const upgraded = await authenticateForProfile(pending, ctx, false);
    if (upgraded.authenticated) {
      await promotePendingSecurityProfile(
        sql,
        station.id,
        station.security_profile,
        pending,
        remoteAddress,
        logger,
      );
      result = upgraded;
      usedProfile = pending;
    }
  }
  result ??= await authenticateForProfile(station.security_profile, ctx, true);

  // A simulator-flagged station: tell the simulator from a real station that
  // uses its identity. Never changes the outcome of the authentication.
  if (result.authenticated && station.is_simulator === true) {
    await reconcileSimulatorIdentity(
      sql,
      {
        stationDbId: station.id,
        stationId,
        securityProfile: usedProfile,
        markerPresent: hasSimulatorMarker(req),
        pairing:
          station.css_enabled == null
            ? null
            : { enabled: station.css_enabled, markerSeenAt: station.css_marker_seen_at ?? null },
        remoteAddress,
      },
      logger,
    );
  }
  return result;
}

interface ProfileAuthContext {
  req: IncomingMessage;
  sql: postgres.Sql;
  logger: Logger;
  stationId: string;
  station: { id: string; basic_auth_password_hash: string | null };
  remoteAddress: string | null;
  // TLS on the socket, or reported by a trusted load balancer that ended it.
  viaTls: boolean;
}

async function authenticateForProfile(
  securityProfile: number,
  ctx: ProfileAuthContext,
  logFailures: boolean,
): Promise<AuthResult> {
  const { req, sql, logger, stationId, station, remoteAddress, viaTls } = ctx;
  const logEvent = logFailures ? logConnectionEvent : async (): Promise<void> => {};

  // SP0: no authentication required
  if (securityProfile === 0) {
    logger.debug({ stationId }, 'SP0: accepting connection without credentials');
    return { authenticated: true, stationId, stationDbId: station.id };
  }

  // SP3: require TLS + valid client certificate (no password needed)
  if (securityProfile === 3) {
    const isTls = 'encrypted' in req.socket && req.socket.encrypted === true;
    if (!isTls) {
      await logEvent(
        sql,
        station.id,
        'auth_failed',
        remoteAddress,
        {
          reason: 'SP3 requires TLS',
        },
        logger,
      );
      return {
        authenticated: false,
        stationId,
        stationDbId: station.id,
        error: 'SP3 requires TLS',
        failure: 'tls_required',
      };
    }

    const tlsSocket = req.socket as import('node:tls').TLSSocket;
    const cert = tlsSocket.getPeerCertificate();
    if (Object.keys(cert).length === 0) {
      await logEvent(
        sql,
        station.id,
        'auth_failed',
        remoteAddress,
        {
          reason: 'No client certificate presented',
        },
        logger,
      );
      return {
        authenticated: false,
        stationId,
        stationDbId: station.id,
        error: 'Client certificate required for SP3',
        failure: 'client_certificate',
      };
    }

    if (!tlsSocket.authorized) {
      const authError = tlsSocket.authorizationError;
      await logEvent(
        sql,
        station.id,
        'auth_failed',
        remoteAddress,
        {
          reason: 'Client certificate rejected',
          error: String(authError),
        },
        logger,
      );
      return {
        authenticated: false,
        stationId,
        stationDbId: station.id,
        error: 'Client certificate not trusted',
        failure: 'client_certificate',
      };
    }

    // Defense in depth: the CA chain check above only proves the cert was
    // issued by a trusted CA. It does NOT prove this cert belongs to THIS
    // station. Without the per-station serial check, any station holding a
    // valid CA-signed cert could impersonate any other SP3 station. Match
    // on (stationId, serialNumber, active, ChargingStationCertificate).
    // Node's getPeerCertificate() can leave serialNumber undefined when the
    // cert lacks the extension entirely; the prior `=== ''` check missed
    // that case and the DB-lookup branch below silently returned "serial
    // not registered" instead of the real "no serial" reason. Cover both.
    const certSerial = cert.serialNumber as string | undefined;
    if (certSerial == null || certSerial === '') {
      await logEvent(
        sql,
        station.id,
        'auth_failed',
        remoteAddress,
        {
          reason: 'Client certificate missing serial number',
        },
        logger,
      );
      return {
        authenticated: false,
        stationId,
        stationDbId: station.id,
        error: 'Client certificate missing serial number',
        failure: 'client_certificate',
      };
    }
    // Node returns the serial uppercase without separators; normalize the DB
    // side too in case it was stored from a different source.
    const normalizedSerial = certSerial.toUpperCase().replace(/[^0-9A-F]/g, '');
    const certRows = await sql`
      SELECT id FROM station_certificates
      WHERE station_id = ${station.id}
        AND UPPER(REGEXP_REPLACE(serial_number, '[^0-9A-Fa-f]', '', 'g')) = ${normalizedSerial}
        AND status = 'active'
        AND certificate_type = 'ChargingStationCertificate'
      LIMIT 1
    `;
    if (certRows.length === 0) {
      await logEvent(
        sql,
        station.id,
        'auth_failed',
        remoteAddress,
        {
          reason: 'Client certificate serial not registered for this station',
          certSerial: normalizedSerial,
        },
        logger,
      );
      return {
        authenticated: false,
        stationId,
        stationDbId: station.id,
        error: 'Client certificate not registered for this station',
        failure: 'client_certificate',
      };
    }

    logger.debug(
      { stationId, cn: cert.subject.CN, certSerial: normalizedSerial },
      'SP3: authenticated via client certificate',
    );
    return { authenticated: true, stationId, stationDbId: station.id };
  }

  // SP2: require TLS. A load balancer may end it; SP3 needs the client
  // certificate on this socket, so only SP2 accepts that.
  if (securityProfile === 2) {
    if (!viaTls) {
      await logEvent(
        sql,
        station.id,
        'auth_failed',
        remoteAddress,
        {
          reason: 'SP2 requires TLS',
        },
        logger,
      );
      return {
        authenticated: false,
        stationId,
        stationDbId: station.id,
        error: 'Security Profile 2 requires TLS',
        failure: 'tls_required',
      };
    }
  }

  // SP1 and SP2: require Basic auth
  const authHeader = req.headers['authorization'];
  if (authHeader == null) {
    await logEvent(
      sql,
      station.id,
      'auth_failed',
      remoteAddress,
      {
        reason: 'Missing credentials',
      },
      logger,
    );
    return {
      authenticated: false,
      stationId,
      stationDbId: station.id,
      error: 'Basic auth credentials required',
      failure: 'credentials',
    };
  }

  if (!authHeader.startsWith('Basic ')) {
    await logEvent(
      sql,
      station.id,
      'auth_failed',
      remoteAddress,
      {
        reason: 'Invalid auth scheme',
      },
      logger,
    );
    return {
      authenticated: false,
      stationId,
      stationDbId: station.id,
      error: 'Invalid auth scheme',
      failure: 'credentials',
    };
  }

  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
  const colonIndex = decoded.indexOf(':');
  const username = colonIndex >= 0 ? decoded.slice(0, colonIndex) : decoded;
  const password = colonIndex >= 0 ? decoded.slice(colonIndex + 1) : '';

  // OCPP 1.6 §4.7 and OCPP 2.1 SP1/SP2 require the Basic auth username to
  // equal the ChargingStationId from the URL path. Without this check, a
  // station presenting valid credentials for station A could connect to
  // station B's URL and inherit B's identity for the session.
  if (username !== stationId) {
    await logEvent(
      sql,
      station.id,
      'auth_failed',
      remoteAddress,
      {
        reason: 'Username does not equal ChargingStationId',
      },
      logger,
    );
    return {
      authenticated: false,
      stationId,
      stationDbId: station.id,
      error: 'Username must equal the ChargingStationId',
      failure: 'credentials',
    };
  }

  if (station.basic_auth_password_hash == null) {
    await logEvent(
      sql,
      station.id,
      'auth_failed',
      remoteAddress,
      {
        reason: 'No password configured',
      },
      logger,
    );
    return {
      authenticated: false,
      stationId,
      stationDbId: station.id,
      error: 'No password configured for station',
      failure: 'credentials',
    };
  }

  try {
    const valid = await verify(station.basic_auth_password_hash, password);
    if (!valid) {
      await logEvent(
        sql,
        station.id,
        'auth_failed',
        remoteAddress,
        {
          reason: 'Invalid password',
        },
        logger,
      );
      return {
        authenticated: false,
        stationId,
        stationDbId: station.id,
        error: 'Invalid credentials',
        failure: 'credentials',
      };
    }
  } catch (err: unknown) {
    logger.error(
      { stationId, error: err instanceof Error ? err.message : String(err) },
      'Password verification error',
    );
    return {
      authenticated: false,
      stationId,
      stationDbId: station.id,
      error: 'Authentication error',
      failure: 'unavailable',
    };
  }

  logger.debug({ stationId }, 'Station authenticated via Basic Auth');
  return { authenticated: true, stationId, stationDbId: station.id };
}

async function promotePendingSecurityProfile(
  sql: postgres.Sql,
  stationDbId: string,
  fromProfile: number,
  toProfile: number,
  remoteAddress: string | null,
  logger: Logger,
): Promise<void> {
  // Fail open: the station authenticated with the new profile; a failed write
  // only delays the promotion to its next connection.
  try {
    await sql`
      UPDATE charging_stations
      SET security_profile = ${toProfile}, pending_security_profile = NULL, updated_at = now(),
        basic_auth_password_hash = CASE WHEN ${toProfile} = 3 THEN NULL ELSE basic_auth_password_hash END
      WHERE id = ${stationDbId} AND pending_security_profile = ${toProfile}
    `;
  } catch (err) {
    logger.warn({ err, stationDbId, toProfile }, 'Failed to promote pending security profile');
    return;
  }
  logger.info({ stationDbId, fromProfile, toProfile }, 'Security profile upgrade completed');
  await logConnectionEvent(
    sql,
    stationDbId,
    'security_profile_upgraded',
    remoteAddress,
    { fromProfile, toProfile },
    logger,
  );
}
