// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createServer as createHttpsServer } from 'node:https';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import type { IncomingMessage } from 'node:http';
import postgres from 'postgres';
import { createLogger, InMemoryEventBus, OcppError } from '@evtivity/lib';
import type { Logger, EventBus, EventPersistence } from '@evtivity/lib';
import { ConnectionManager } from './connection-manager.js';
import { createSessionState } from './session-state.js';
import type { SessionState } from './session-state.js';
import { MessageCorrelator } from './message-correlator.js';
import { MessageRouter } from './message-router.js';
import { GracefulShutdown } from './graceful-shutdown.js';
import { PingMonitor } from './ping-monitor.js';
import { MiddlewarePipeline } from './middleware/pipeline.js';
import type { HandlerContext } from './middleware/pipeline.js';
import { logMiddleware } from './middleware/log.js';
import { validateMiddleware } from './middleware/validate.js';
import { createRateLimitMiddleware } from './middleware/rate-limit.js';
import { createDedupMiddleware } from './middleware/dedup.js';
import { createBootGuardMiddleware } from './middleware/boot-guard.js';
import { authenticateConnection } from './middleware/authenticate.js';
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
  databaseUrl?: string | undefined;
  tls?: TlsOptions | undefined;
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
  private wss: WebSocketServer | null = null;
  private wssSecure: WebSocketServer | null = null;
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
    this.sql = options?.databaseUrl ? postgres(options.databaseUrl) : null;

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
      handleProtocols: (protocols) => {
        if (protocols.has('ocpp2.1')) return 'ocpp2.1';
        if (protocols.has('ocpp1.6')) return 'ocpp1.6';
        return false;
      },
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
      void this.handleConnection(ws, req);
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
        // Must be false: SP2 stations connect without client certs on the same port.
        // SP3 client cert validation is handled by the auth middleware.
        rejectUnauthorized: false,
      });

      this.wssSecure = new WebSocketServer({
        server: httpsServer,
        maxPayload: 1 * 1024 * 1024,
        handleProtocols: (protocols) => {
          if (protocols.has('ocpp2.1')) return 'ocpp2.1';
          if (protocols.has('ocpp1.6')) return 'ocpp1.6';
          return false;
        },
      });

      this.wssSecure.on('connection', (ws: WebSocket, req: IncomingMessage) => {
        void this.handleConnection(ws, req);
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

    this.logger.info(
      { port: options.port, host: options.host ?? '0.0.0.0' },
      'OCPP server started',
    );
  }

  private async handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const remoteIp = req.socket.remoteAddress ?? 'unknown';

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

    // Idle timeout: close connections with no messages for 5 minutes.
    // OCPP heartbeat interval is typically 30-60 seconds, so 5 minutes is generous.
    const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
    let idleTimer = setTimeout(() => {
      this.logger.info({ remoteIp }, 'Closing idle WebSocket connection (pre-auth)');
      ws.close(1000, 'Idle timeout');
    }, IDLE_TIMEOUT_MS);

    // Register message listener before async auth to avoid losing messages
    // that arrive while authenticateConnection queries the DB.
    const pendingMessages: string[] = [];
    let session: SessionState | null = null;

    ws.on('message', (data: Buffer) => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const sid = session?.stationId ?? remoteIp;
        this.logger.info({ stationId: sid }, 'Closing idle WebSocket connection');
        ws.close(1000, 'Idle timeout');
      }, IDLE_TIMEOUT_MS);
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

      const raw = data.toString('utf-8');
      if (session == null) {
        pendingMessages.push(raw);
        return;
      }
      void this.handleMessage(ws, session, raw);
    });

    const auth = await authenticateConnection(req, this.logger, this.sql);
    if (!auth.authenticated || auth.stationId == null) {
      // Surface buffered messages so operators can see what an unauthenticated
      // client tried to send before being kicked. Silent drop here hid both
      // misconfigured stations (legitimate but with bad creds) and probe
      // traffic. Cap the logged payload to avoid log-flood from a flooder.
      if (pendingMessages.length > 0) {
        this.logger.warn(
          {
            stationId: auth.stationId,
            droppedCount: pendingMessages.length,
            firstMessagePreview: pendingMessages[0]?.slice(0, 200),
            error: auth.error,
          },
          'Discarded buffered messages from unauthenticated connection',
        );
      }
      this.logger.warn({ error: auth.error }, 'Connection rejected');
      ws.close(1008, auth.error ?? 'Authentication failed');
      return;
    }

    const stationId = auth.stationId;
    session = createSessionState(stationId, ws.protocol || 'ocpp2.1');
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

    const confirmedSession = session;
    ws.on('close', () => {
      this.correlator.clearPending(confirmedSession);
      this.connectionManager.remove(stationId);
      void this.eventBus.publish({
        eventType: 'station.Disconnected',
        aggregateType: 'ChargingStation',
        aggregateId: stationId,
        payload: { stationId, remoteAddress: remoteIp },
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

    // Drain messages that arrived during authentication
    for (const raw of pendingMessages) {
      void this.handleMessage(ws, session, raw);
    }
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
    let parsed: OcppMessage;
    try {
      parsed = JSON.parse(raw) as OcppMessage;
    } catch {
      this.logger.warn({ stationId: session.stationId }, 'Invalid JSON received');
      return;
    }

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
    await this.pingMonitor.stop();
    if (this.wssSecure != null) {
      const secure = this.wssSecure;
      await new Promise<void>((resolve) => {
        secure.close(() => {
          resolve();
        });
      });
    }
    if (this.shutdown != null) {
      await this.shutdown.shutdown();
    }
    if (this.sql != null) {
      await this.sql.end();
    }
  }
}
