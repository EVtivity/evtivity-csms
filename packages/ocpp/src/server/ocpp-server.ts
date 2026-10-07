// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createServer as createHttpsServer } from 'node:https';
import type { Server as HttpsServer } from 'node:https';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import type postgres from 'postgres';
import { createLogger, InMemoryEventBus, OcppError, tryParseJson } from '@evtivity/lib';
import { getHeartbeatIntervalSeconds } from '@evtivity/database';
import type { Logger, EventBus, EventPersistence } from '@evtivity/lib';
import { ConnectionManager } from './connection-manager.js';
import { createSessionState } from './session-state.js';
import { selectOcppSubprotocol } from './subprotocol.js';
import type { SessionState } from './session-state.js';
import { MessageCorrelator } from './message-correlator.js';
import { MessageRouter } from './message-router.js';
import { GracefulShutdown, SERVER_SHUTDOWN_DISCONNECT_REASON } from './graceful-shutdown.js';
import { PingMonitor } from './ping-monitor.js';
import { isTlsConnection, parseTrustedProxies, resolveClientIp } from './client-ip.js';
import { MiddlewarePipeline } from './middleware/pipeline.js';
import type { HandlerContext } from './middleware/pipeline.js';
import { logMiddleware } from './middleware/log.js';
import { validateMiddleware } from './middleware/validate.js';
import { createRateLimitMiddleware } from './middleware/rate-limit.js';
import { createDedupMiddleware } from './middleware/dedup.js';
import { createBootGuardMiddleware } from './middleware/boot-guard.js';
import {
  authenticateConnection,
  rejectionFor,
  serviceUnavailable,
} from './middleware/authenticate.js';
import type { AuthResult } from './middleware/authenticate.js';
import {
  ConnectionAuthBusyError,
  ConnectionAuthLimiter,
  DEFAULT_CONNECTION_AUTH_MAX_QUEUED,
  DEFAULT_CONNECTION_AUTH_MAX_WAIT_MS,
  defaultConnectionAuthConcurrency,
} from './connection-auth-limiter.js';
import type { ConnectionAuthLimits, ConnectionAuthStats } from './connection-auth-limiter.js';
import { MessageLifecycle } from './message-lifecycle.js';
import { CommandDispatcher } from './command-dispatcher.js';
import { registerHandlers } from '../handlers/handler-registry.js';
import {
  isCall,
  isCallResult,
  isCallError,
  createCallResult,
  createCallError,
  MESSAGE_TYPE_CALL,
  MESSAGE_TYPE_CALLRESULT,
  MESSAGE_TYPE_CALLERROR,
} from '../protocol/message-types.js';
import type { OcppMessage } from '../protocol/message-types.js';
import { OcppErrorCode } from '../protocol/error-codes.js';

import { config } from '../lib/config.js';

const MAX_CONNECTIONS_PER_IP = config.OCPP_MAX_CONNECTIONS_PER_IP;
const MAX_MESSAGES_PER_IP_PER_SECOND = config.OCPP_MAX_MESSAGES_PER_IP_PER_SECOND;
const IP_MESSAGE_WINDOW_MS = 1000;

const ipConnectionCounts = new Map<string, number>();
// Upgrade requests per IP whose authentication is still running. They count
// toward the per-IP connection limit, so one IP cannot queue unbounded station
// lookups and argon2 verifications.
const ipPendingAuthCounts = new Map<string, number>();
const ipMessageCounters = new Map<string, { count: number; windowStart: number }>();

// ipMessageCounters entries are only refreshed when the same IP sends
// another message; an IP that sends once and goes silent leaves its
// counter in the Map forever. On a public-facing server that fields
// random internet probes the Map drifts upward indefinitely. Sweep stale
// entries on a 60s cadence the same way rate-limit.ts does for its
// per-station counters.
const IP_COUNTER_STALE_MS = 5 * 60 * 1000;
const IP_COUNTER_CLEANUP_MS = 60 * 1000;
let ipMessageCleanupTimer: NodeJS.Timeout | null = null;
function ensureIpMessageCleanup(): void {
  if (ipMessageCleanupTimer != null) return;
  ipMessageCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, counter] of ipMessageCounters) {
      if (now - counter.windowStart > IP_COUNTER_STALE_MS) {
        ipMessageCounters.delete(ip);
      }
    }
  }, IP_COUNTER_CLEANUP_MS);
  // Don't keep the event loop alive solely for cleanup; the OCPP server's
  // own listeners are what should hold it.
  ipMessageCleanupTimer.unref();
}

export interface TlsOptions {
  // PEM content (not file paths). The caller is responsible for reading the
  // material from disk or env var before passing it in.
  cert: string;
  key: string;
  ca?: string | undefined;
  port?: number | undefined;
}

export interface OcppServerOptions {
  port: number;
  host?: string | undefined;
  eventPersistence?: EventPersistence | undefined;
  eventBus?: EventBus | undefined;
  // Shared pool owned by the caller; the server never closes it.
  sql?: postgres.Sql | undefined;
  // Comma-separated CIDRs of load balancers whose X-Forwarded-For is trusted.
  trustedProxyCidrs?: string | undefined;
  tls?: TlsOptions | undefined;
  // Fixed idle timeout (tests). By default it follows the heartbeat setting.
  idleTimeoutMs?: number | undefined;
  // Bounds on concurrent connection authentications. By default half the
  // database pool, 1000 queued, 10 s wait (see connection-auth-limiter.ts).
  connectionAuthLimits?: Partial<ConnectionAuthLimits> | undefined;
}

// Refused connection authentications are logged at most this often.
const AUTH_BUSY_LOG_INTERVAL_MS = 5_000;

// A connection with no OCPP message and no WebSocket ping or pong for this long
// is closed. The default is twice the heartbeat interval handed out at boot,
// never less than 5 minutes, so a station that heartbeats exactly on schedule
// and does not answer pings is not closed as its heartbeat arrives.
const MIN_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_TIMEOUT_REFRESH_MS = 60_000;

// How long stop() waits, after the station sockets close, for event-bus
// handlers to finish (station.Disconnected projections, notifications). The
// caller closes pub/sub, Redis and the database after stop() returns. Socket
// close (10 s) plus this stays inside the 30 s ECS stop timeout and the
// Kubernetes termination grace period.
export const EVENT_DRAIN_TIMEOUT_MS = 10_000;

export function idleTimeoutForHeartbeat(heartbeatSeconds: number): number {
  return Math.max(MIN_IDLE_TIMEOUT_MS, heartbeatSeconds * 2 * 1000);
}

export class OcppServer {
  private readonly logger = createLogger('ocpp-server');
  private readonly connectionManager: ConnectionManager;
  private readonly correlator: MessageCorrelator;
  private readonly router: MessageRouter;
  private readonly pipeline: MiddlewarePipeline;
  private readonly eventBus: EventBus;
  private readonly lifecycle: MessageLifecycle;
  private readonly dispatcher: CommandDispatcher;
  private readonly pingMonitor: PingMonitor;
  private readonly sql: postgres.Sql | null;
  private readonly trustedProxies: ReturnType<typeof parseTrustedProxies>;
  private readonly fixedIdleTimeoutMs: number | null;
  private readonly authLimiter: ConnectionAuthLimiter;
  private authBusyLoggedAt = 0;
  private authBusySinceLog = 0;
  private idleTimeoutMs = MIN_IDLE_TIMEOUT_MS;
  private idleTimeoutRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private wss: WebSocketServer | null = null;
  private wssSecure: WebSocketServer | null = null;
  private httpsServer: HttpsServer | null = null;
  // Auth results from verifyClient, handed to handleConnection for the same
  // upgrade request.
  private readonly verifiedRequests = new WeakMap<IncomingMessage, AuthResult>();
  private shutdown: GracefulShutdown | null = null;

  constructor(options?: Partial<OcppServerOptions>) {
    this.connectionManager = new ConnectionManager(this.logger);
    this.correlator = new MessageCorrelator(this.logger);
    this.router = new MessageRouter(this.logger);
    this.eventBus =
      options?.eventBus ??
      new InMemoryEventBus(this.logger, options?.eventPersistence, {
        // Per-frame telemetry already lands in its own queryable table
        // (ocpp_message_logs, meter_values, charging_stations.last_heartbeat)
        // via projections; archiving it again in domain_events accounted for
        // ~87% of that table's rows with no readers.
        persistDenylist: ['ocpp.MessageLog', 'ocpp.MeterValues', 'ocpp.Heartbeat'],
      });
    this.lifecycle = new MessageLifecycle(this.logger);
    this.dispatcher = new CommandDispatcher(this.connectionManager, this.correlator, this.logger);
    this.pingMonitor = new PingMonitor(this.connectionManager, this.logger);
    this.sql = options?.sql ?? null;
    this.trustedProxies = parseTrustedProxies(options?.trustedProxyCidrs ?? '');
    this.fixedIdleTimeoutMs = options?.idleTimeoutMs ?? null;
    if (this.fixedIdleTimeoutMs != null) this.idleTimeoutMs = this.fixedIdleTimeoutMs;
    const limits = options?.connectionAuthLimits;
    this.authLimiter = new ConnectionAuthLimiter({
      maxConcurrent:
        limits?.maxConcurrent ?? defaultConnectionAuthConcurrency(this.sql?.options.max ?? 10),
      maxQueued: limits?.maxQueued ?? DEFAULT_CONNECTION_AUTH_MAX_QUEUED,
      maxWaitMs: limits?.maxWaitMs ?? DEFAULT_CONNECTION_AUTH_MAX_WAIT_MS,
    });

    // Set up middleware pipeline
    this.pipeline = new MiddlewarePipeline();
    this.pipeline.use(createRateLimitMiddleware());
    this.pipeline.use(createDedupMiddleware());
    this.pipeline.use(logMiddleware);
    // Boot guard precedes validate: a non-booted (Pending/Rejected) station must get
    // SecurityError for any non-BootNotification CALL, even one whose payload is malformed
    // (OCPP 2.1 B01.FR.10, and the Pending-specific B02.FR.09).
    this.pipeline.use(createBootGuardMiddleware());
    this.pipeline.use(validateMiddleware);
    this.pipeline.use(this.router.asMiddleware());

    // Register handlers
    registerHandlers(this.router);
  }

  async start(options: OcppServerOptions): Promise<void> {
    ensureIpMessageCleanup();
    this.wss = new WebSocketServer({
      port: options.port,
      host: options.host,
      maxPayload: 1 * 1024 * 1024,
      verifyClient: (info, callback) => {
        this.verifyClient(info.req, callback);
      },
      handleProtocols: (protocols) => selectOcppSubprotocol(protocols) ?? false,
    });

    // Wait for the WebSocket server to bind the port
    const wss = this.wss;
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });

    this.shutdown = new GracefulShutdown(
      this.wss,
      this.connectionManager,
      this.correlator,
      this.logger,
    );

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    this.wss.on('error', (err: Error) => {
      this.logger.error({ error: err.message }, 'WebSocket server error');
    });

    // TLS server for SP2 (wss://)
    if (options.tls != null) {
      const tlsPort = options.tls.port ?? 8443;
      const httpsServer = createHttpsServer({
        cert: options.tls.cert,
        key: options.tls.key,
        ...(options.tls.ca != null ? { ca: options.tls.ca } : {}),
        requestCert: true,
        // Must be false: SP2 stations connect without a client certificate on the
        // same port, and true would drop them during the handshake. Node still
        // verifies any client certificate against `ca` and records the result in
        // socket.authorized; the auth middleware (authenticate.ts) rejects an SP3
        // station whose certificate is missing or not authorized.
        rejectUnauthorized: false,
      });
      this.httpsServer = httpsServer;

      this.wssSecure = new WebSocketServer({
        server: httpsServer,
        maxPayload: 1 * 1024 * 1024,
        verifyClient: (info, callback) => {
          this.verifyClient(info.req, callback);
        },
        handleProtocols: (protocols) => selectOcppSubprotocol(protocols) ?? false,
      });

      this.wssSecure.on('connection', (ws: WebSocket, req: IncomingMessage) => {
        this.handleConnection(ws, req);
      });

      this.wssSecure.on('error', (err: Error) => {
        this.logger.error({ error: err.message }, 'Secure WebSocket server error');
      });

      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          httpsServer.removeListener('error', onError);
          reject(err);
        };
        httpsServer.once('error', onError);
        httpsServer.listen(tlsPort, options.host ?? '0.0.0.0', () => {
          httpsServer.removeListener('error', onError);
          resolve();
        });
      });
      this.logger.info(
        { port: tlsPort, host: options.host ?? '0.0.0.0' },
        'OCPP TLS server started (wss://)',
      );
    }

    this.pingMonitor.start(this.sql);

    if (this.fixedIdleTimeoutMs == null && this.sql != null) {
      await this.refreshIdleTimeout();
      this.idleTimeoutRefreshTimer = setInterval(() => {
        void this.refreshIdleTimeout();
      }, IDLE_TIMEOUT_REFRESH_MS);
      this.idleTimeoutRefreshTimer.unref();
    }

    this.logger.info(
      { port: options.port, host: options.host ?? '0.0.0.0' },
      'OCPP server started',
    );
  }

  // Authenticate before the WebSocket upgrade so a rejected station gets an
  // HTTP status instead of an accepted upgrade followed by a close frame.
  // Stations that send Basic auth only in response to a 401 challenge could
  // not connect otherwise.
  private verifyClient(
    req: IncomingMessage,
    callback: (
      result: boolean,
      code?: number,
      message?: string,
      headers?: OutgoingHttpHeaders,
    ) => void,
  ): void {
    const remoteIp = resolveClientIp(req, this.trustedProxies) ?? 'unknown';

    // Connections over the per-IP limit are closed right after the upgrade
    // in handleConnection; skip the station lookup for them.
    if ((ipConnectionCounts.get(remoteIp) ?? 0) >= MAX_CONNECTIONS_PER_IP) {
      callback(true);
      return;
    }

    const pendingCount = ipPendingAuthCounts.get(remoteIp) ?? 0;
    if ((ipConnectionCounts.get(remoteIp) ?? 0) + pendingCount >= MAX_CONNECTIONS_PER_IP) {
      this.logger.warn(
        { remoteIp, pending: pendingCount },
        'Per-IP pending authentication limit exceeded',
      );
      callback(false, 429, 'Too Many Requests');
      return;
    }
    ipPendingAuthCounts.set(remoteIp, pendingCount + 1);
    const releasePending = (): void => {
      const count = ipPendingAuthCounts.get(remoteIp) ?? 1;
      if (count <= 1) {
        ipPendingAuthCounts.delete(remoteIp);
      } else {
        ipPendingAuthCounts.set(remoteIp, count - 1);
      }
    };

    // A reconnect wave queues here instead of filling the database pool.
    this.authLimiter
      .run(() => {
        // The station gave up while the request waited: skip the lookup.
        if (req.socket.destroyed) {
          return Promise.resolve<AuthResult>({
            authenticated: false,
            stationId: null,
            stationDbId: null,
            error: 'Connection closed while waiting for authentication',
            failure: 'unavailable',
          });
        }
        return authenticateConnection(
          req,
          this.logger,
          this.sql,
          remoteIp === 'unknown' ? null : remoteIp,
          isTlsConnection(req, this.trustedProxies),
        );
      })
      .then((auth) => {
        releasePending();
        if (auth.authenticated && auth.stationId != null) {
          this.verifiedRequests.set(req, auth);
          callback(true);
          return;
        }
        const rejection = rejectionFor(auth);
        this.logger.warn(
          { stationId: auth.stationId, error: auth.error, status: rejection.status },
          'Connection rejected',
        );
        callback(false, rejection.status, rejection.message, rejection.headers);
      })
      .catch((err: unknown) => {
        releasePending();
        const unavailable = serviceUnavailable();
        if (err instanceof ConnectionAuthBusyError) {
          this.logAuthBusy(err);
        } else {
          this.logger.error(
            { error: err instanceof Error ? err.message : String(err) },
            'Connection authentication failed',
          );
        }
        callback(false, unavailable.status, unavailable.message, unavailable.headers);
      });
  }

  // One warning per interval with the number refused since the last one, so a
  // reconnect wave does not log a line per station.
  private logAuthBusy(err: ConnectionAuthBusyError): void {
    this.authBusySinceLog++;
    const now = Date.now();
    if (now - this.authBusyLoggedAt < AUTH_BUSY_LOG_INTERVAL_MS) return;
    this.logger.warn(
      { ...this.authLimiter.stats(), reason: err.reason, refused: this.authBusySinceLog },
      'Connection authentication busy: refused station connections with 503',
    );
    this.authBusyLoggedAt = now;
    this.authBusySinceLog = 0;
  }

  /** Connection authentications running, queued, and refused (health endpoint). */
  getConnectionAuthStats(): ConnectionAuthStats {
    return this.authLimiter.stats();
  }

  // The CSMS sends a station queued commands and screen messages only once it
  // may: after a BootNotification it answered Accepted, or, for a station that
  // reconnected without rebooting (no BootNotification), after its first other
  // message. Before that the station answers every CSMS call with SecurityError.
  private announceReady(session: SessionState, action: string): void {
    if (session.readyAnnounced) return;
    const bootAccepted = session.bootStatus === 'Accepted';
    const reconnectedWithoutBoot = session.bootStatus === null && action !== 'BootNotification';
    if (!bootAccepted && !reconnectedWithoutBoot) return;
    session.readyAnnounced = true;
    void this.eventBus.publish({
      eventType: 'station.Ready',
      aggregateType: 'ChargingStation',
      aggregateId: session.stationId,
      payload: {
        stationId: session.stationId,
        stationDbId: session.stationDbId,
        ocppProtocol: session.ocppProtocol,
      },
    });
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const remoteIp = resolveClientIp(req, this.trustedProxies) ?? 'unknown';

    // Per-IP connection limit
    const currentCount = ipConnectionCounts.get(remoteIp) ?? 0;
    if (currentCount >= MAX_CONNECTIONS_PER_IP) {
      this.logger.warn({ remoteIp, count: currentCount }, 'Per-IP connection limit exceeded');
      ws.close(1008, 'Too many connections from this IP');
      return;
    }
    ipConnectionCounts.set(remoteIp, currentCount + 1);
    ws.on('close', () => {
      clearTimeout(idleTimer);
      const count = ipConnectionCounts.get(remoteIp) ?? 1;
      if (count <= 1) {
        ipConnectionCounts.delete(remoteIp);
      } else {
        ipConnectionCounts.set(remoteIp, count - 1);
      }
    });

    // Any OCPP message or WebSocket ping/pong restarts the idle timer. The
    // ping monitor pings every station every 30s, so live connections answer.
    const closeIdle = (): void => {
      this.logger.info({ remoteIp }, 'Closing idle WebSocket connection');
      ws.close(1000, 'Idle timeout');
    };
    let armedIdleMs = this.idleTimeoutMs;
    let idleTimer = setTimeout(closeIdle, armedIdleMs);
    const restartIdleTimer = (): void => {
      if (armedIdleMs === this.idleTimeoutMs) {
        idleTimer.refresh();
        return;
      }
      clearTimeout(idleTimer);
      armedIdleMs = this.idleTimeoutMs;
      idleTimer = setTimeout(closeIdle, armedIdleMs);
    };
    ws.on('ping', restartIdleTimer);
    ws.on('pong', restartIdleTimer);

    const auth = this.verifiedRequests.get(req);
    this.verifiedRequests.delete(req);
    if (auth?.stationId == null) {
      // verifyClient stores a result for every accepted upgrade under the limit.
      this.logger.error({ remoteIp }, 'Upgraded connection without authentication result');
      ws.close(1011, 'Authentication failed');
      return;
    }

    const stationId = auth.stationId;
    const session = createSessionState(stationId, ws.protocol || 'ocpp2.1');
    session.authenticated = true;
    if (auth.stationDbId != null) {
      session.stationDbId = auth.stationDbId;
    }
    this.connectionManager.add(stationId, ws, session);

    // Fallback for when auth did not resolve DB ID (e.g. no sql connection)
    if (session.stationDbId == null) {
      void this.resolveStationDbId(stationId, session);
    }

    void this.eventBus.publish({
      eventType: 'station.Connected',
      aggregateType: 'ChargingStation',
      aggregateId: stationId,
      payload: {
        stationId,
        stationDbId: session.stationDbId,
        ocppProtocol: ws.protocol || null,
        remoteAddress: remoteIp,
      },
    });

    this.pingMonitor.writeNow();

    ws.on('message', (data: Buffer) => {
      restartIdleTimer();
      // Per-IP message rate limit
      const now = Date.now();
      let ipCounter = ipMessageCounters.get(remoteIp);
      if (ipCounter == null || now - ipCounter.windowStart >= IP_MESSAGE_WINDOW_MS) {
        ipCounter = { count: 0, windowStart: now };
        ipMessageCounters.set(remoteIp, ipCounter);
      }
      ipCounter.count++;
      if (ipCounter.count > MAX_MESSAGES_PER_IP_PER_SECOND) {
        this.logger.warn(
          { remoteIp, count: ipCounter.count },
          'Per-IP message rate limit exceeded',
        );
        ws.close(1008, 'Message rate limit exceeded');
        return;
      }

      void this.handleMessage(ws, session, data.toString('utf-8'));
    });

    ws.on('close', () => {
      this.correlator.clearPending(session);
      // A connection replaced by a newer one is not a disconnect.
      if (!this.connectionManager.remove(stationId, ws)) return;
      // A socket closed by stop() is not a station failure: the projection
      // still records the disconnect but sends no fault notices.
      const serverShutdown = this.shutdown?.isShuttingDown() === true;
      void this.eventBus.publish({
        eventType: 'station.Disconnected',
        aggregateType: 'ChargingStation',
        aggregateId: stationId,
        payload: {
          stationId,
          remoteAddress: remoteIp,
          ...(serverShutdown ? { reason: SERVER_SHUTDOWN_DISCONNECT_REASON } : {}),
        },
      });

      this.pingMonitor.writeNow();
    });

    ws.on('pong', () => {
      this.pingMonitor.recordPong(stationId);
    });

    ws.on('error', (err: Error) => {
      this.logger.error({ stationId, error: err.message }, 'WebSocket error');
      ws.close(1011, 'WebSocket error');
    });
  }

  private async refreshIdleTimeout(): Promise<void> {
    const heartbeatSeconds = await getHeartbeatIntervalSeconds();
    this.idleTimeoutMs = idleTimeoutForHeartbeat(heartbeatSeconds);
    this.pingMonitor.setHeartbeatIntervalSeconds(heartbeatSeconds);
  }

  private async resolveStationDbId(stationId: string, session: SessionState): Promise<void> {
    if (this.sql == null) return;
    try {
      const rows = await this.sql`SELECT id FROM charging_stations WHERE station_id = ${stationId}`;
      const row = rows[0];
      if (row != null) {
        session.stationDbId = row.id as string;
      }
    } catch (err: unknown) {
      this.logger.warn(
        { stationId, error: err instanceof Error ? err.message : String(err) },
        'Failed to resolve station DB ID',
      );
    }
  }

  private async handleMessage(ws: WebSocket, session: SessionState, raw: string): Promise<void> {
    const json = tryParseJson(raw);
    if (json === undefined) {
      this.logger.warn({ stationId: session.stationId }, 'Invalid JSON received');
      return;
    }
    const parsed = json as OcppMessage;

    if (!Array.isArray(parsed) || parsed.length < 3) {
      this.logger.warn({ stationId: session.stationId }, 'Invalid OCPP message format');
      return;
    }

    const messageType = parsed[0];

    // Handle responses to our outgoing calls
    if (messageType === MESSAGE_TYPE_CALLRESULT || messageType === MESSAGE_TYPE_CALLERROR) {
      // Station is alive — it responded. Update liveness clock so
      // PingMonitor.checkHeartbeats() doesn't disconnect stations that
      // are actively responding to CSMS-initiated commands.
      session.lastHeartbeat = new Date();
      if (isCallResult(parsed)) {
        // Log the inbound CALLRESULT so operators can see what the station
        // returned for CSMS-initiated commands. Without this the OCPP log
        // tab only carries the outbound CALL row (logged by
        // command-listener.ts) and the response is invisible.
        void this.eventBus.publish({
          eventType: 'ocpp.MessageLog',
          aggregateType: 'ChargingStation',
          aggregateId: session.stationId,
          payload: {
            stationId: session.stationId,
            stationDbId: session.stationDbId,
            direction: 'inbound',
            messageType: MESSAGE_TYPE_CALLRESULT,
            messageId: parsed[1],
            action: null,
            payload: parsed[2],
          },
        });
        this.correlator.handleResponse(session, parsed);
      } else if (isCallError(parsed)) {
        void this.eventBus.publish({
          eventType: 'ocpp.MessageLog',
          aggregateType: 'ChargingStation',
          aggregateId: session.stationId,
          payload: {
            stationId: session.stationId,
            stationDbId: session.stationDbId,
            direction: 'inbound',
            messageType: MESSAGE_TYPE_CALLERROR,
            messageId: parsed[1],
            action: null,
            errorCode: parsed[2],
            errorDescription: parsed[3],
          },
        });
        this.correlator.handleResponse(session, parsed);
      }
      return;
    }

    // Handle incoming calls
    if (!isCall(parsed)) {
      this.logger.warn({ stationId: session.stationId, messageType }, 'Unsupported message type');
      return;
    }

    const [, messageId, action, payload] = parsed;

    this.lifecycle.received(messageId, session.stationId, action);

    // OCPP 2.1 G02.FR.04 and OCPP 1.6 section 4.6 both require the CSMS to
    // assume availability of a station whenever any message has been received
    // from it — a station MAY skip the Heartbeat if another PDU was sent in
    // the interval. Reset the liveness clock on every inbound CALL so
    // PingMonitor.checkHeartbeats() doesn't close connections on stations
    // that are actively sending MeterValues, StatusNotifications, etc.
    session.lastHeartbeat = new Date();

    // Log inbound CALL from station
    void this.eventBus.publish({
      eventType: 'ocpp.MessageLog',
      aggregateType: 'ChargingStation',
      aggregateId: session.stationId,
      payload: {
        stationId: session.stationId,
        stationDbId: session.stationDbId,
        direction: 'inbound',
        messageType: MESSAGE_TYPE_CALL,
        messageId,
        action,
        payload,
      },
    });

    const ctx: HandlerContext = {
      stationId: session.stationId,
      stationDbId: session.stationDbId,
      session,
      protocolVersion: session.ocppProtocol,
      messageId,
      action,
      payload,
      logger: this.logger,
      eventBus: this.eventBus,
      correlator: this.correlator,
      dispatcher: this.dispatcher,
    };

    try {
      this.lifecycle.processing(messageId);
      await this.pipeline.execute(ctx);

      if (ctx.response != null) {
        const result = createCallResult(messageId, ctx.response);
        ws.send(JSON.stringify(result));
        this.lifecycle.responded(messageId);
        this.announceReady(session, action);

        // Log outbound CALLRESULT to station
        void this.eventBus.publish({
          eventType: 'ocpp.MessageLog',
          aggregateType: 'ChargingStation',
          aggregateId: session.stationId,
          payload: {
            stationId: session.stationId,
            stationDbId: session.stationDbId,
            direction: 'outbound',
            messageType: MESSAGE_TYPE_CALLRESULT,
            messageId,
            action,
            payload: ctx.response,
          },
        });
      }
    } catch (err: unknown) {
      if (err instanceof OcppError) {
        const error = createCallError(
          messageId,
          err.errorCode,
          err.errorDescription,
          err.errorDetails,
        );
        ws.send(JSON.stringify(error));
        this.lifecycle.errored(messageId, err.errorCode);

        // Log outbound CALLERROR to station
        void this.eventBus.publish({
          eventType: 'ocpp.MessageLog',
          aggregateType: 'ChargingStation',
          aggregateId: session.stationId,
          payload: {
            stationId: session.stationId,
            stationDbId: session.stationDbId,
            direction: 'outbound',
            messageType: MESSAGE_TYPE_CALLERROR,
            messageId,
            action,
            errorCode: err.errorCode,
            errorDescription: err.errorDescription,
          },
        });
      } else {
        this.logger.error(
          { messageId, action, error: err instanceof Error ? err.message : String(err) },
          'Unhandled error in message processing',
        );
        const error = createCallError(
          messageId,
          OcppErrorCode.InternalError,
          'Internal server error',
        );
        ws.send(JSON.stringify(error));
        this.lifecycle.errored(messageId, OcppErrorCode.InternalError);

        // Log outbound CALLERROR to station
        void this.eventBus.publish({
          eventType: 'ocpp.MessageLog',
          aggregateType: 'ChargingStation',
          aggregateId: session.stationId,
          payload: {
            stationId: session.stationId,
            stationDbId: session.stationDbId,
            direction: 'outbound',
            messageType: MESSAGE_TYPE_CALLERROR,
            messageId,
            action,
            errorCode: OcppErrorCode.InternalError,
            errorDescription: 'Internal server error',
          },
        });
      }
    }
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  getConnectionManager(): ConnectionManager {
    return this.connectionManager;
  }

  getCorrelator(): MessageCorrelator {
    return this.correlator;
  }

  getRouter(): MessageRouter {
    return this.router;
  }

  getDispatcher(): CommandDispatcher {
    return this.dispatcher;
  }

  getLifecycle(): MessageLifecycle {
    return this.lifecycle;
  }

  getPingMonitor(): PingMonitor {
    return this.pingMonitor;
  }

  getLogger(): Logger {
    return this.logger;
  }

  async stop(): Promise<void> {
    if (ipMessageCleanupTimer != null) {
      clearInterval(ipMessageCleanupTimer);
      ipMessageCleanupTimer = null;
    }
    if (this.idleTimeoutRefreshTimer != null) {
      clearInterval(this.idleTimeoutRefreshTimer);
      this.idleTimeoutRefreshTimer = null;
    }
    await this.pingMonitor.stop();
    // Stop accepting TLS connections now, but await the close only after the
    // station sockets are closed: ws emits 'close' for a server built on an
    // external HTTPS server only once its last client is gone, so awaiting it
    // first waited for as long as any TLS station stayed connected.
    const secure = this.wssSecure;
    const https = this.httpsServer;
    const secureClosed =
      secure == null
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            secure.close(() => {
              resolve();
            });
          });
    const httpsClosed =
      https == null
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            https.close(() => {
              resolve();
            });
          });
    if (this.shutdown != null) {
      await this.shutdown.shutdown();
    }
    // GracefulShutdown closed (or terminated) every station socket. A TLS
    // socket never registered as a station, and plain HTTPS connections, would
    // still hold the servers open.
    if (secure != null) {
      for (const client of secure.clients) {
        client.terminate();
      }
    }
    https?.closeAllConnections();
    await Promise.all([secureClosed, httpsClosed]);
    // Closing the sockets published station.Disconnected for each station.
    // Wait for those projections (and anything still queued) before the
    // caller ends the database client they write through.
    const drained = await this.eventBus.drain(EVENT_DRAIN_TIMEOUT_MS);
    if (!drained) {
      this.logger.warn(
        { timeoutMs: EVENT_DRAIN_TIMEOUT_MS },
        'Event handlers still running at shutdown; closing anyway',
      );
    }
  }
}
