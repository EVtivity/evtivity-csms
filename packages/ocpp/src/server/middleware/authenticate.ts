// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { IncomingMessage } from 'node:http';
import type postgres from 'postgres';
import { verify } from 'argon2';
import type { Logger } from '@evtivity/lib';

export interface AuthResult {
  authenticated: boolean;
  stationId: string | null;
  stationDbId: string | null;
  error?: string | undefined;
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
): Promise<AuthResult> {
  const stationId = extractStationId(req.url);
  if (stationId == null) {
    return {
      authenticated: false,
      stationId: null,
      stationDbId: null,
      error: 'Missing station ID in URL',
    };
  }

  // Without a database connection, reject in production, allow in test
  if (sql == null) {
    if (process.env['NODE_ENV'] === 'test') {
      logger.warn({ stationId }, 'No database connection; skipping auth validation (test mode)');
      return { authenticated: true, stationId, stationDbId: null };
    }
    logger.error({ stationId }, 'No database connection; rejecting connection');
    return { authenticated: false, stationId, stationDbId: null, error: 'Database unavailable' };
  }

  // Look up station in database
  const rows = await sql`
    SELECT id, security_profile, basic_auth_password_hash, availability, onboarding_status
    FROM charging_stations
    WHERE station_id = ${stationId}
  `;
  const station = rows[0] as
    | {
        id: string;
        security_profile: number;
        basic_auth_password_hash: string | null;
        availability: string;
        onboarding_status: string;
      }
    | undefined;

  if (station == null) {
    logger.warn({ stationId }, 'Connection rejected: unknown station');
    return { authenticated: false, stationId, stationDbId: null, error: 'Unknown station' };
  }

  if (station.onboarding_status === 'blocked') {
    logger.warn({ stationId }, 'Connection rejected: station is blocked');
    return {
      authenticated: false,
      stationId,
      stationDbId: station.id,
      error: 'Station is blocked',
    };
  }

  // Pending stations are allowed to connect so operators can send OCPP commands
  // during onboarding. Charging is blocked at the API level instead.
  // Blocked stations are rejected here at the connection level.

  const remoteAddress = req.socket.remoteAddress ?? null;
  const securityProfile = station.security_profile;

  // SP0: no authentication required
  if (securityProfile === 0) {
    logger.debug({ stationId }, 'SP0: accepting connection without credentials');
    return { authenticated: true, stationId, stationDbId: station.id };
  }

  // SP3: require TLS + valid client certificate (no password needed)
  if (securityProfile === 3) {
    const isTls = 'encrypted' in req.socket && req.socket.encrypted === true;
    if (!isTls) {
      await logAuthEvent(
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
      };
    }

    const tlsSocket = req.socket as import('node:tls').TLSSocket;
    const cert = tlsSocket.getPeerCertificate();
    if (Object.keys(cert).length === 0) {
      await logAuthEvent(
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
      };
    }

    if (!tlsSocket.authorized) {
      const authError = tlsSocket.authorizationError;
      await logAuthEvent(
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
      await logAuthEvent(
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
      await logAuthEvent(
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
      };
    }

    logger.debug(
      { stationId, cn: cert.subject.CN, certSerial: normalizedSerial },
      'SP3: authenticated via client certificate',
    );
    return { authenticated: true, stationId, stationDbId: station.id };
  }

  // SP2: require TLS
  if (securityProfile === 2) {
    const isTls = 'encrypted' in req.socket && req.socket.encrypted === true;
    if (!isTls) {
      await logAuthEvent(
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
      };
    }
  }

  // SP1 and SP2: require Basic auth
  const authHeader = req.headers['authorization'];
  if (authHeader == null) {
    await logAuthEvent(
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
    };
  }

  if (!authHeader.startsWith('Basic ')) {
    await logAuthEvent(
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
    await logAuthEvent(
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
    };
  }

  if (station.basic_auth_password_hash == null) {
    await logAuthEvent(
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
    };
  }

  try {
    const valid = await verify(station.basic_auth_password_hash, password);
    if (!valid) {
      await logAuthEvent(
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
    };
  }

  logger.debug({ stationId }, 'Station authenticated via Basic Auth');
  return { authenticated: true, stationId, stationDbId: station.id };
}

async function logAuthEvent(
  sql: postgres.Sql,
  stationDbId: string,
  event: string,
  remoteAddress: string | null,
  metadata: Record<string, unknown>,
  logger: Logger,
): Promise<void> {
  try {
    await sql`
      INSERT INTO connection_logs (station_id, event, remote_address, metadata)
      VALUES (${stationDbId}, ${event}, ${remoteAddress}, ${sql.json(metadata as Parameters<postgres.Sql['json']>[0])})
    `;
  } catch (err) {
    // Best-effort logging; do not fail the auth flow, but surface the failure
    // so operators notice when forensic logs go missing.
    logger.warn({ err, stationDbId, event }, 'Failed to write connection_logs row');
  }
}
