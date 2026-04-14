// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { OcppVersion } from './types.js';

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

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Mini OCPP WebSocket server that acts as a CSMS for CS conformance testing.
 * Accepts exactly one station connection per test.
 */
export class OcppTestServer {
  private httpServer: Server | null = null;
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

  get isConnected(): boolean {
    return this._isConnected;
  }

  get stationId(): string | null {
    return this._stationId;
  }

  get protocol(): OcppVersion | null {
    return this._protocol;
  }

  /**
   * Start the server on a dynamic port.
   */
  async start(): Promise<{ port: number; url: string }> {
    return new Promise((resolve, reject) => {
      this.httpServer = createServer();
      this.wss = new WebSocketServer({
        server: this.httpServer,
        handleProtocols: (protocols) => {
          if (protocols.has('ocpp2.1')) return 'ocpp2.1';
          if (protocols.has('ocpp1.6')) return 'ocpp1.6';
          return false;
        },
      });

      this.wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
        this.handleConnection(socket, req);
      });

      this.httpServer.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer?.address();
        if (addr == null || typeof addr === 'string') {
          reject(new Error('Failed to get server address'));
          return;
        }
        const port = addr.port;
        resolve({ port, url: `ws://127.0.0.1:${String(port)}` });
      });

      this.httpServer.on('error', reject);
    });
  }

  /**
   * Stop the server and close all connections.
   */
  async stop(): Promise<void> {
    this.cleanup();
    return new Promise((resolve) => {
      if (this.wss != null) {
        this.wss.close(() => {
          if (this.httpServer != null) {
            this.httpServer.close(() => {
              resolve();
            });
          } else {
            resolve();
          }
        });
      } else if (this.httpServer != null) {
        this.httpServer.close(() => {
          resolve();
        });
      } else {
        resolve();
      }
    });
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
        reject(new Error(`Timed out waiting for ${action} after ${String(timeoutMs)}ms`));
      }, timeoutMs);

      this.messageWaiters.push({ action, resolve, reject, timeout });
    });
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
    if (this.ws != null) {
      this.ws.close();
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
    // Reject connections when the test has explicitly blocked them
    if (this.rejectConnections) {
      socket.close(4004, 'Server not accepting connections');
      return;
    }
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
      this.handleMessage(data);
    });

    socket.on('close', () => {
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
    let msg: unknown;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf-8'));
    } catch {
      return;
    }

    if (!Array.isArray(msg) || msg.length < 3) return;

    const messageType = msg[0] as number;

    if (messageType === 2) {
      // CALL from station
      const [, messageId, action, payload] = msg as OcppCall;
      this.handleIncomingCall(messageId, action, payload);
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
