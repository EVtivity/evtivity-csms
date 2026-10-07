// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import type { SecureContextOptions, SecureVersion, TLSSocket } from 'node:tls';
import { randomUUID, type X509Certificate } from 'node:crypto';
import { tryParseJson } from '@evtivity/lib';
import type { OcppVersion } from './types.js';

/** The station did not send the awaited message within the wait. */
export class MessageTimeoutError extends Error {
  constructor(
    readonly action: string,
    readonly timeoutMs: number,
  ) {
    super(`Timed out waiting for ${action} after ${String(timeoutMs)}ms`);
    this.name = 'MessageTimeoutError';
  }
}

type OcppCall = [2, string, string, Record<string, unknown>];
type OcppCallResult = [3, string, Record<string, unknown>];
type OcppCallError = [4, string, string, string, Record<string, unknown>];

type PendingCall = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type MessageHandler = (
  action: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

type MessageWaiter = {
  action: string;
  resolve: (payload: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

/** TLS settings for a wss:// test server (security profile 2 and 3 tests). */
export interface TestServerTls {
  /** Server certificate (PEM) and its private key. */
  cert: string;
  key: string;
  /** Ask the station for a client certificate (security profile 3). */
  requestCert: boolean;
  /** CA certificates the station client certificates must chain to. */
  ca?: string | undefined;
  /** TLS versions the server offers (default TLS 1.2 to 1.3). */
  minVersion?: SecureVersion | undefined;
  maxVersion?: SecureVersion | undefined;
}

/** What the Test System observed of the TLS connection an HTTP upgrade came over. */
export interface TlsHandshakeInfo {
  protocol: string | null;
  cipher: string | null;
  /** Cipher suites the station offered in its ClientHello (IANA code points). */
  offeredCipherSuites: number[];
  /** Station client certificate, when it sent one. */
  clientCertificate: X509Certificate | null;
  /** The client certificate chains to the server's `ca`. */
  clientCertificateAuthorized: boolean;
  clientCertificateError: string | null;
}

/** One HTTP upgrade request the station sent. */
export interface UpgradeAttempt {
  at: number;
  url: string;
  authorization: string | null;
  accepted: boolean;
  tls: TlsHandshakeInfo | null;
}

// TLS cipher suite code points (IANA).
export const TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256 = 0xc02b;
export const TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384 = 0xc02c;
export const TLS_RSA_WITH_AES_128_GCM_SHA256 = 0x009c;
export const TLS_RSA_WITH_AES_256_GCM_SHA384 = 0x009d;

/**
 * Cipher suites of a TLS ClientHello record, or null while the record is
 * incomplete. Throws when the data is not a ClientHello.
 */
export function parseClientHelloCipherSuites(data: Buffer): number[] | null {
  if (data.length < 5) return null;
  if (data[0] !== 0x16) throw new Error('Not a TLS handshake record');
  const recordLength = data.readUInt16BE(3);
  if (data.length < 5 + recordLength) return null;
  let offset = 5;
  if (data[offset] !== 0x01) throw new Error('Not a ClientHello');
  offset += 4; // handshake type + length
  offset += 2 + 32; // client_version + random
  const sessionIdLength = data[offset] ?? 0;
  offset += 1 + sessionIdLength;
  const suitesLength = data.readUInt16BE(offset);
  offset += 2;
  const suites: number[] = [];
  for (let i = 0; i < suitesLength; i += 2) suites.push(data.readUInt16BE(offset + i));
  return suites;
}

function secureContextOptions(tls: TestServerTls): SecureContextOptions {
  const legacy = tls.maxVersion === 'TLSv1' || tls.maxVersion === 'TLSv1.1';
  return {
    cert: tls.cert,
    key: tls.key,
    ...(tls.ca != null ? { ca: tls.ca } : {}),
    minVersion: tls.minVersion ?? (legacy ? 'TLSv1' : 'TLSv1.2'),
    maxVersion: tls.maxVersion ?? 'TLSv1.3',
    // OpenSSL refuses TLS 1.0/1.1 at the default security level.
    ...(legacy ? { ciphers: 'DEFAULT@SECLEVEL=0' } : {}),
  };
}

/** A TLS handshake the server saw, with the client certificate (DER) when one was sent. */
export interface TlsHandshake {
  at: number;
  ok: boolean;
  clientCertificate: Buffer | null;
  error?: string;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Mini OCPP WebSocket server that acts as a CSMS for CS conformance testing.
 * Accepts exactly one station connection per test.
 */
export class OcppTestServer {
  private httpServer: Server | HttpsServer | null = null;
  // TLS mode: a TCP front reads each ClientHello before the TLS server takes the socket.
  private netServer: NetServer | null = null;
  private tlsSettings: TestServerTls | null = null;
  private readonly offeredSuitesByPort = new Map<number, number[]>();
  private readonly openSockets = new Set<Socket>();
  private readonly _upgradeAttempts: UpgradeAttempt[] = [];
  private readonly handshakes: TlsHandshake[] = [];
  private readonly handshakeWaiters: Array<(h: TlsHandshake) => void> = [];
  private wss: WebSocketServer | null = null;
  private ws: WebSocket | null = null;
  private _stationId: string | null = null;
  private _protocol: OcppVersion | null = null;
  private _isConnected = false;

  private readonly pending = new Map<string, PendingCall>();
  private messageHandler: MessageHandler | null = null;
  private readonly messageWaiters: MessageWaiter[] = [];
  private readonly receivedMessages: Array<{ action: string; payload: Record<string, unknown> }> =
    [];

  private connectionResolver: ((stationId: string) => void) | null = null;
  private connectionRejecter: ((reason: Error) => void) | null = null;
  private rejectConnections = false;

  /** Times (ms epoch) of connection attempts the Test System refused. */
  get refusedAttempts(): readonly number[] {
    return this._upgradeAttempts.filter((a) => !a.accepted).map((a) => a.at);
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  get stationId(): string | null {
    return this._stationId;
  }

  get protocol(): OcppVersion | null {
    return this._protocol;
  }

  /** HTTP upgrade requests received, oldest first. */
  get upgradeAttempts(): readonly UpgradeAttempt[] {
    return this._upgradeAttempts;
  }

  /** The most recent HTTP upgrade request. */
  get lastUpgrade(): UpgradeAttempt | null {
    return this._upgradeAttempts[this._upgradeAttempts.length - 1] ?? null;
  }

  /**
   * Start the server on an ephemeral port. With `tls` it serves wss:// on localhost
   * and records every TLS handshake (see tlsHandshakes()).
   */
  async start(tls?: TestServerTls): Promise<{ port: number; url: string }> {
    return new Promise((resolve, reject) => {
      if (tls != null) {
        this.tlsSettings = tls;
        const server = createHttpsServer({
          ...secureContextOptions(tls),
          requestCert: tls.requestCert,
          // The test validates the client certificate itself.
          rejectUnauthorized: false,
        });
        server.on('secureConnection', (socket: TLSSocket) => {
          const peer = socket.getPeerCertificate();
          this.recordHandshake({
            at: Date.now(),
            ok: true,
            clientCertificate: Object.keys(peer).length > 0 ? peer.raw : null,
          });
        });
        server.on('tlsClientError', (err: Error) => {
          this.recordHandshake({
            at: Date.now(),
            ok: false,
            clientCertificate: null,
            error: err.message,
          });
        });
        this.httpServer = server;
      } else {
        this.httpServer = createServer();
      }
      this.wss = new WebSocketServer({
        server: this.httpServer,
        handleProtocols: (protocols) => {
          if (protocols.has('ocpp2.1')) return 'ocpp2.1';
          if (protocols.has('ocpp1.6')) return 'ocpp1.6';
          return false;
        },
        // Records each upgrade. A Test System that does not accept a reconnect
        // refuses the HTTP upgrade, so the station never sees an open connection.
        verifyClient: (info, done) => {
          const accepted = !this.rejectConnections;
          this._upgradeAttempts.push({
            at: Date.now(),
            url: info.req.url ?? '/',
            authorization: info.req.headers['authorization'] ?? null,
            accepted,
            tls: this.tlsSettings != null ? this.tlsInfo(info.req) : null,
          });
          if (!accepted) {
            done(false, 503, 'Not accepting connections');
            return;
          }
          done(true);
        },
      });

      this.wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
        this.handleConnection(socket, req);
      });

      // An ephemeral port per server, so parallel runs never collide.
      const listener: Server | HttpsServer | NetServer =
        tls != null ? this.createTlsFront() : this.httpServer;
      listener.listen(0, '127.0.0.1', () => {
        const addr = listener.address();
        if (addr == null || typeof addr === 'string') {
          reject(new Error('Failed to get server address'));
          return;
        }
        const port = addr.port;
        // A TLS server is addressed by host name, which its certificate names.
        resolve({
          port,
          url: tls != null ? `wss://localhost:${String(port)}` : `ws://127.0.0.1:${String(port)}`,
        });
      });

      listener.on('error', reject);
    });
  }

  // TCP front of a TLS server: records the ClientHello cipher suites, then hands
  // the socket (with the bytes read) to the HTTPS server.
  private createTlsFront(): NetServer {
    const https = this.httpServer as HttpsServer;
    this.netServer = createNetServer((socket: Socket) => {
      this.openSockets.add(socket);
      socket.on('close', () => {
        this.openSockets.delete(socket);
      });
      let buffered = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        buffered = Buffer.concat([buffered, chunk]);
        let suites: number[] | null;
        try {
          suites = parseClientHelloCipherSuites(buffered);
        } catch {
          // fail-open: a record that is not a ClientHello offers no cipher suites
          suites = [];
        }
        if (suites == null) return;
        socket.removeListener('data', onData);
        socket.pause();
        if (socket.remotePort != null) this.offeredSuitesByPort.set(socket.remotePort, suites);
        socket.unshift(buffered);
        https.emit('connection', socket);
      };
      socket.on('data', onData);
      socket.on('error', () => {
        // The TLS server reports handshake failures (tlsClientError).
      });
    });
    return this.netServer;
  }

  private tlsInfo(req: IncomingMessage): TlsHandshakeInfo {
    const socket = req.socket as TLSSocket;
    const peer = socket.getPeerX509Certificate();
    return {
      protocol: socket.getProtocol(),
      cipher: socket.getCipher().standardName,
      offeredCipherSuites:
        socket.remotePort != null ? (this.offeredSuitesByPort.get(socket.remotePort) ?? []) : [],
      clientCertificate: peer ?? null,
      clientCertificateAuthorized: socket.authorized,
      clientCertificateError: socket.authorized ? null : String(socket.authorizationError),
    };
  }

  /**
   * Replace the TLS settings (server certificate, CA, TLS versions) for the next
   * handshakes. Connections already open keep theirs.
   */
  setTlsOptions(tls: TestServerTls): void {
    if (this.tlsSettings == null || this.httpServer == null) {
      throw new Error('setTlsOptions needs a TLS server');
    }
    this.tlsSettings = tls;
    (this.httpServer as HttpsServer).setSecureContext(secureContextOptions(tls));
  }

  /** Serve a different certificate from the next TLS handshake. */
  setServerCertificate(cert: string, key: string): void {
    if (this.tlsSettings == null) {
      throw new Error('setServerCertificate needs a TLS server');
    }
    this.setTlsOptions({ ...this.tlsSettings, cert, key });
  }

  /** TLS handshakes seen so far, oldest first. */
  tlsHandshakes(): readonly TlsHandshake[] {
    return this.handshakes;
  }

  /** Resolves with the next TLS handshake after this call. */
  waitForTlsHandshake(timeoutMs: number): Promise<TlsHandshake> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.handshakeWaiters.indexOf(onHandshake);
        if (idx !== -1) this.handshakeWaiters.splice(idx, 1);
        reject(new Error(`No TLS handshake within ${String(timeoutMs)}ms`));
      }, timeoutMs);
      const onHandshake = (h: TlsHandshake): void => {
        clearTimeout(timer);
        resolve(h);
      };
      this.handshakeWaiters.push(onHandshake);
    });
  }

  private recordHandshake(h: TlsHandshake): void {
    this.handshakes.push(h);
    for (const waiter of this.handshakeWaiters.splice(0)) waiter(h);
  }

  /**
   * Stop the server and close all connections.
   */
  async stop(): Promise<void> {
    this.cleanup();
    for (const socket of this.openSockets) socket.destroy();
    this.openSockets.clear();
    if (this.httpServer != null) this.httpServer.closeAllConnections();
    const close = (server: { close: (cb: () => void) => unknown } | null): Promise<void> =>
      new Promise((resolve) => {
        if (server == null) {
          resolve();
          return;
        }
        server.close(() => {
          resolve();
        });
      });
    await close(this.wss);
    await close(this.netServer);
    // In TLS mode the HTTPS server never listened itself.
    if (this.netServer == null) await close(this.httpServer);
  }

  /**
   * Wait for a station to connect.
   */
  waitForConnection(timeoutMs = DEFAULT_CONNECTION_TIMEOUT_MS): Promise<string> {
    if (this._isConnected && this._stationId != null) {
      return Promise.resolve(this._stationId);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectionResolver = null;
        this.connectionRejecter = null;
        reject(new Error(`No station connected within ${String(timeoutMs)}ms`));
      }, timeoutMs);

      this.connectionResolver = (stationId: string) => {
        clearTimeout(timer);
        this.connectionResolver = null;
        this.connectionRejecter = null;
        resolve(stationId);
      };
      this.connectionRejecter = (reason: Error) => {
        clearTimeout(timer);
        this.connectionResolver = null;
        this.connectionRejecter = null;
        reject(reason);
      };
    });
  }

  /**
   * Send a CSMS-initiated command to the station and wait for the response.
   */
  sendCommand(
    action: string,
    payload: Record<string, unknown>,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    if (this.ws == null || !this._isConnected) {
      return Promise.reject(new Error('No station connected'));
    }
    const messageId = randomUUID();
    const call: OcppCall = [2, messageId, action, payload];

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new Error(`Command ${action} timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);

      this.pending.set(messageId, { resolve, reject, timeout });
      this.ws?.send(JSON.stringify(call));
    });
  }

  /**
   * Send a CALLERROR response to a specific message from the station.
   */
  sendCallError(
    messageId: string,
    errorCode: string,
    description = '',
    details: Record<string, unknown> = {},
  ): void {
    if (this.ws == null || !this._isConnected) return;
    const error: OcppCallError = [4, messageId, errorCode, description, details];
    this.ws.send(JSON.stringify(error));
  }

  /**
   * Set a handler for station-initiated messages.
   * The handler receives the action and payload and must return the response payload.
   */
  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Wait for a specific action from the station.
   * Returns the payload of the first matching message.
   * If a matching message was already received (e.g., during auto-boot),
   * resolves immediately with the buffered payload.
   */
  waitForMessage(
    action: string,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    // Check if the message was already received (e.g., from auto-boot)
    const bufferedIdx = this.receivedMessages.findIndex((m) => m.action === action);
    if (bufferedIdx !== -1) {
      const msg = this.receivedMessages[bufferedIdx] as {
        action: string;
        payload: Record<string, unknown>;
      };
      this.receivedMessages.splice(bufferedIdx, 1);
      return Promise.resolve(msg.payload);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.messageWaiters.findIndex(
          (w) => w.action === action && w.resolve === resolve,
        );
        if (idx !== -1) this.messageWaiters.splice(idx, 1);
        reject(new MessageTimeoutError(action, timeoutMs));
      }, timeoutMs);

      this.messageWaiters.push({ action, resolve, reject, timeout });
    });
  }

  /**
   * Like waitForMessage, for a wait whose timeout is an expected outcome:
   * returns null when the station sends no matching message in time and
   * rethrows any other failure.
   */
  async waitForMessageOrNull(
    action: string,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<Record<string, unknown> | null> {
    try {
      return await this.waitForMessage(action, timeoutMs);
    } catch (err) {
      if (err instanceof MessageTimeoutError) return null;
      throw err;
    }
  }

  /**
   * Disconnect the currently connected station and optionally reject
   * reconnection attempts until acceptConnections() is called.
   */
  disconnectStation(rejectReconnect = false): void {
    if (rejectReconnect) {
      this.rejectConnections = true;
    }
    // Clear buffered messages so post-reconnect messages are not mixed
    // with pre-disconnect messages
    this.receivedMessages.length = 0;
    const socket = this.ws;
    if (socket != null) {
      // The connection is gone for the Test System now: waitForConnection()
      // waits for the next connection, and anything the station still sends on
      // this socket is not received.
      this.ws = null;
      this._isConnected = false;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Station disconnected'));
        this.pending.delete(id);
      }
      socket.close();
    }
  }

  /**
   * Allow the server to accept station connections again after
   * disconnectStation(true) was called.
   */
  acceptConnections(): void {
    this.rejectConnections = false;
  }

  /**
   * Clear the received message buffer. Call after auto-boot so tests
   * start with a clean buffer and don't pick up boot messages.
   */
  clearBuffer(): void {
    this.receivedMessages.length = 0;
  }

  private handleConnection(socket: WebSocket, req: IncomingMessage): void {
    // Reject if a station is already connected
    if (this._isConnected) {
      socket.close(4001, 'Only one station connection allowed per test');
      return;
    }

    // Extract stationId from URL path: /{stationId}
    const urlPath = req.url ?? '/';
    const stationId = urlPath.replace(/^\//, '').split('?')[0] ?? '';
    if (stationId === '') {
      socket.close(4002, 'Missing station ID in URL path');
      return;
    }

    // Determine protocol from negotiated subprotocol
    const proto = socket.protocol;
    if (proto === 'ocpp2.1') {
      this._protocol = 'ocpp2.1';
    } else if (proto === 'ocpp1.6') {
      this._protocol = 'ocpp1.6';
    } else {
      socket.close(4003, 'Unsupported OCPP subprotocol');
      return;
    }

    this.ws = socket;
    this._stationId = stationId;
    this._isConnected = true;

    socket.on('message', (data: Buffer | string) => {
      // A socket the Test System already closed delivers nothing more.
      if (this.ws !== socket) return;
      this.handleMessage(data);
    });

    socket.on('close', () => {
      // disconnectStation() detaches the socket at once; a late close event of
      // that socket must not touch a newer connection.
      if (this.ws !== socket) return;
      this._isConnected = false;
      this.ws = null;
      // Reject all pending commands
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Station disconnected'));
        this.pending.delete(id);
      }
    });

    socket.on('error', () => {
      // Errors are followed by close events
    });

    // Notify waiters
    if (this.connectionResolver != null) {
      this.connectionResolver(stationId);
    }
  }

  private handleMessage(data: Buffer | string): void {
    const msg = tryParseJson(typeof data === 'string' ? data : data.toString('utf-8'));
    if (!Array.isArray(msg) || msg.length < 3) return;

    const messageType = msg[0] as number;

    if (messageType === 2) {
      // CALL from station
      const [, messageId, action, payload] = msg as OcppCall;
      this.handleIncomingCall(messageId, action, payload);
    } else if (messageType === 6) {
      // SEND from station (OCPP 2.1): recorded like a CALL, never answered
      const [, , action, payload] = msg as OcppCall;
      this.handleIncomingSend(action, payload);
    } else if (messageType === 3) {
      // CALLRESULT from station (response to our command)
      const [, messageId, payload] = msg as OcppCallResult;
      const pending = this.pending.get(messageId);
      if (pending != null) {
        clearTimeout(pending.timeout);
        this.pending.delete(messageId);
        pending.resolve(payload);
      }
    } else if (messageType === 4) {
      // CALLERROR from station
      const [, messageId, errorCode, errorDescription] = msg as OcppCallError;
      const pending = this.pending.get(messageId);
      if (pending != null) {
        clearTimeout(pending.timeout);
        this.pending.delete(messageId);
        pending.reject(new Error(`CALLERROR ${errorCode}: ${errorDescription}`));
      }
    }
  }

  private handleIncomingCall(
    messageId: string,
    action: string,
    payload: Record<string, unknown>,
  ): void {
    // Check waiters first
    const waiterIdx = this.messageWaiters.findIndex((w) => w.action === action);
    if (waiterIdx !== -1) {
      const waiter = this.messageWaiters[waiterIdx] as MessageWaiter;
      clearTimeout(waiter.timeout);
      this.messageWaiters.splice(waiterIdx, 1);
      // Still need to respond to the station
      if (this.messageHandler != null) {
        this.messageHandler(action, payload)
          .then((response) => {
            this.sendCallResult(messageId, response);
            waiter.resolve(payload);
          })
          .catch(() => {
            this.sendCallResult(messageId, {});
            waiter.resolve(payload);
          });
      } else {
        // Auto-respond with empty payload and resolve the waiter
        this.sendCallResult(messageId, {});
        waiter.resolve(payload);
      }
      return;
    }

    // Buffer the message so future waitForMessage() calls can find it
    this.receivedMessages.push({ action, payload });

    // Use the message handler
    if (this.messageHandler != null) {
      this.messageHandler(action, payload)
        .then((response) => {
          this.sendCallResult(messageId, response);
        })
        .catch((err: unknown) => {
          const desc = err instanceof Error ? err.message : String(err);
          this.sendCallError(messageId, 'InternalError', desc);
        });
    } else {
      // No handler: auto-accept with empty payload
      this.sendCallResult(messageId, {});
    }
  }

  private handleIncomingSend(action: string, payload: Record<string, unknown>): void {
    const waiterIdx = this.messageWaiters.findIndex((w) => w.action === action);
    if (waiterIdx !== -1) {
      const waiter = this.messageWaiters[waiterIdx] as MessageWaiter;
      clearTimeout(waiter.timeout);
      this.messageWaiters.splice(waiterIdx, 1);
      waiter.resolve(payload);
      return;
    }
    this.receivedMessages.push({ action, payload });
  }

  private sendCallResult(messageId: string, payload: Record<string, unknown>): void {
    if (this.ws == null || !this._isConnected) return;
    const result: OcppCallResult = [3, messageId, payload];
    this.ws.send(JSON.stringify(result));
  }

  private cleanup(): void {
    // Clear all pending commands
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Server stopping'));
      this.pending.delete(id);
    }
    // Clear all waiters
    for (const waiter of this.messageWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('Server stopping'));
    }
    this.messageWaiters.length = 0;
    this.receivedMessages.length = 0;

    // Close station connection
    if (this.ws != null) {
      this.ws.close();
      this.ws = null;
    }
    this._isConnected = false;
    this._stationId = null;
    this._protocol = null;
  }
}
