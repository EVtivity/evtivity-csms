// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

type OcppCall = [2, string, string, Record<string, unknown>];
type OcppCallResult = [3, string, Record<string, unknown>];

type PendingCall = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export interface OcppClientOptions {
  serverUrl: string;
  stationId: string;
  ocppProtocol: 'ocpp1.6' | 'ocpp2.1';
  password?: string | undefined;
  securityProfile?: number | undefined;
  clientCert?: string | undefined;
  clientKey?: string | undefined;
  caCert?: string | undefined;
}

export type IncomingCallHandler = (
  messageId: string,
  action: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export class OcppClient {
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private connected = false;
  private destroyed = false;
  private reconnecting = false;
  private onIncomingCall: IncomingCallHandler | null = null;
  private onConnectedCallback: (() => void) | null = null;
  private onDisconnectedCallback: (() => void) | null = null;

  private readonly _stationId: string;
  private readonly _protocol: 'ocpp1.6' | 'ocpp2.1';
  private readonly serverUrl: string;
  private readonly password: string;
  private readonly securityProfile: number;
  private readonly clientCert: string | undefined;
  private readonly clientKey: string | undefined;
  private readonly caCert: string | undefined;

  private static readonly BASE_RECONNECT_DELAY_MS = 2000;
  private static readonly MAX_RECONNECT_DELAY_MS = 300_000; // 5 minutes cap
  private static readonly CALL_TIMEOUT_MS = 30_000;

  constructor(options: OcppClientOptions) {
    this.serverUrl = options.serverUrl;
    this._stationId = options.stationId;
    this._protocol = options.ocppProtocol;
    this.password = options.password ?? 'password';
    this.securityProfile = options.securityProfile ?? 1;
    this.clientCert = options.clientCert;
    this.clientKey = options.clientKey;
    this.caCert = options.caCert;
  }

  get isConnected(): boolean {
    return this.connected && this.ws != null;
  }

  get stationId(): string {
    return this._stationId;
  }

  get protocol(): 'ocpp1.6' | 'ocpp2.1' {
    return this._protocol;
  }

  setIncomingCallHandler(handler: IncomingCallHandler): void {
    this.onIncomingCall = handler;
  }

  setConnectedHandler(handler: () => void): void {
    this.onConnectedCallback = handler;
  }

  setDisconnectedHandler(handler: () => void): void {
    this.onDisconnectedCallback = handler;
  }

  connect(): Promise<void> {
    const url = `${this.serverUrl}/${this._stationId}`;

    // SP0: no auth headers. SP1/SP2: Basic Auth. SP3: client certificate (no password).
    const headers: Record<string, string> = {};
    if (this.securityProfile >= 1 && this.securityProfile < 3) {
      headers['authorization'] =
        'Basic ' + Buffer.from(`${this._stationId}:${this.password}`).toString('base64');
    }

    // WebSocket options: TLS for SP2/SP3, client cert for SP3
    const wsOptions: Record<string, unknown> = {
      headers,
      rejectUnauthorized: process.env['TLS_REJECT_UNAUTHORIZED'] === 'true',
    };
    if (this.caCert != null) wsOptions['ca'] = this.caCert;
    if (this.securityProfile === 3) {
      if (this.clientCert != null) wsOptions['cert'] = this.clientCert;
      if (this.clientKey != null) wsOptions['key'] = this.clientKey;
    }

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url, [this._protocol], wsOptions);

      this.ws.on('open', () => {
        this.connected = true;
        if (this.onConnectedCallback == null) {
          console.log(`[${this._stationId}] Connected to ${url}`);
        }
        resolve();
      });

      this.ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        this.handleMessage(
          Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8'),
        );
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        this.connected = false;
        if (this.onDisconnectedCallback != null) {
          this.onDisconnectedCallback();
        } else {
          console.log(`[${this._stationId}] Disconnected: ${String(code)} ${reason.toString()}`);
        }
        if (!this.destroyed) {
          void this.reconnect();
        }
      });

      this.ws.on('error', (err: Error) => {
        console.error(`[${this._stationId}] Error: ${err.message}`);
        if (!this.connected) {
          reject(err);
        }
      });
    });
  }

  sendCall(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (this.ws == null || !this.connected) {
        reject(new Error('Not connected'));
        return;
      }

      const messageId = randomUUID();
      const call: OcppCall = [2, messageId, action, payload];

      const timeout = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new Error(`Timeout waiting for ${action} response`));
      }, OcppClient.CALL_TIMEOUT_MS);

      this.pending.set(messageId, { resolve, reject, timeout });

      this.ws.send(JSON.stringify(call), (err) => {
        if (err != null) {
          clearTimeout(timeout);
          this.pending.delete(messageId);
          reject(err);
        }
      });
    });
  }

  sendCallResult(messageId: string, payload: Record<string, unknown>): void {
    if (this.ws == null || !this.connected) return;
    const result: OcppCallResult = [3, messageId, payload];
    this.ws.send(JSON.stringify(result));
  }

  sendCallError(messageId: string, errorCode: string, errorDescription?: string): void {
    if (this.ws == null || !this.connected) return;
    const callError = [4, messageId, errorCode, errorDescription ?? '', {}];
    this.ws.send(JSON.stringify(callError));
  }

  disconnect(): void {
    this.destroyed = true;
    // Clear all pending calls to prevent unhandled rejections from lingering timeouts
    for (const [id, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(new Error('Client disconnected'));
      this.pending.delete(id);
    }
    if (this.ws != null) {
      this.ws.close(1000, 'Client shutting down');
      this.ws = null;
    }
  }

  /** Simulate a connection loss (close WS but allow auto-reconnect). */
  simulateConnectionLoss(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(new Error('Connection lost'));
      this.pending.delete(id);
    }
    if (this.ws != null) {
      this.ws.close(1001, 'Connection lost');
      this.ws = null;
    }
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;

    // Clear pending calls that will never get responses
    for (const [id, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(new Error('WebSocket closed during reconnect'));
      this.pending.delete(id);
    }

    const { BASE_RECONNECT_DELAY_MS, MAX_RECONNECT_DELAY_MS } = OcppClient;
    let attempt = 0;

    while (!this.destroyed) {
      attempt++;

      const delay = Math.min(
        BASE_RECONNECT_DELAY_MS * Math.pow(2, attempt - 1),
        MAX_RECONNECT_DELAY_MS,
      );
      const jitter = Math.random() * delay * 0.2;
      const waitMs = delay + jitter;

      console.log(
        `[${this._stationId}] Reconnect attempt ${String(attempt)} in ${String(Math.round(waitMs))}ms...`,
      );

      await new Promise((r) => setTimeout(r, waitMs));

      // Re-check after async wait (destroyed may change during sleep)
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (this.destroyed) break;

      try {
        await this.connect();
        console.log(`[${this._stationId}] Reconnected after ${String(attempt)} attempt(s)`);
        this.reconnecting = false;
        if (this.onConnectedCallback != null) {
          this.onConnectedCallback();
        }
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[${this._stationId}] Reconnect attempt ${String(attempt)} failed: ${message}`,
        );
      }
    }

    this.reconnecting = false;
  }

  private handleMessage(raw: string): void {
    let parsed: unknown[];
    try {
      parsed = JSON.parse(raw) as unknown[];
    } catch {
      console.error(`[${this._stationId}] Invalid JSON: ${raw}`);
      return;
    }

    if (!Array.isArray(parsed) || parsed.length < 3) return;

    const messageType = parsed[0] as number;

    // CALLRESULT [3, messageId, payload]
    if (messageType === 3) {
      const messageId = parsed[1] as string;
      const payload = parsed[2] as Record<string, unknown>;
      const p = this.pending.get(messageId);
      if (p != null) {
        clearTimeout(p.timeout);
        this.pending.delete(messageId);
        p.resolve(payload);
      }
      return;
    }

    // CALLERROR [4, messageId, errorCode, errorDescription, errorDetails]
    if (messageType === 4) {
      const messageId = parsed[1] as string;
      const errorCode = parsed[2] as string;
      const errorDesc = parsed[3] as string;
      const p = this.pending.get(messageId);
      if (p != null) {
        clearTimeout(p.timeout);
        this.pending.delete(messageId);
        p.reject(new Error(`CALLERROR ${errorCode}: ${errorDesc}`));
      }
      return;
    }

    // CALL from CSMS [2, messageId, action, payload]
    if (messageType === 2) {
      const messageId = parsed[1] as string;
      const action = parsed[2] as string;
      const payload = parsed[3] as Record<string, unknown>;

      if (this.onIncomingCall == null) {
        console.warn(
          `[${this._stationId}] No incoming call handler registered, returning NotSupported for ${action}`,
        );
        this.sendCallResult(messageId, { status: 'NotSupported' });
        return;
      }

      this.onIncomingCall(messageId, action, payload)
        .then((response) => {
          this.sendCallResult(messageId, response);
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          // OCPP error codes thrown by handlers are sent as CALLERROR frames
          const ocppErrors = [
            'NotImplemented',
            'NotSupported',
            'InternalError',
            'ProtocolError',
            'SecurityError',
            'FormationViolation',
            'PropertyConstraintViolation',
            'OccurrenceConstraintViolation',
            'TypeConstraintViolation',
            'GenericError',
          ];
          if (ocppErrors.includes(msg)) {
            this.sendCallError(messageId, msg, `${action} ${msg}`);
          } else {
            console.error(`[${this._stationId}] Error handling ${action}: ${msg}`);
            this.sendCallError(messageId, 'InternalError', msg);
          }
        });
    }
  }
}
