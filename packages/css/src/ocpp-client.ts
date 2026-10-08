// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import {
  SIMULATOR_CONNECTION_HEADER,
  SIMULATOR_CONNECTION_HEADER_VALUE,
  tryParseJson,
} from '@evtivity/lib';

// Errors a TLS client raises when it does not accept the server certificate.
const SERVER_CERTIFICATE_ERRORS = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_CERT_WILDCARD',
]);

/** True when a connection failed because the server certificate was not accepted. */
export function isServerCertificateError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && SERVER_CERTIFICATE_ERRORS.has(code);
}

// The server offered no TLS version the client accepts (TLS 1.2 or above).
const TLS_VERSION_ERRORS = new Set([
  'ERR_SSL_UNSUPPORTED_PROTOCOL',
  'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

/** True when a connection failed because the server's TLS version is below 1.2. */
export function isTlsVersionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : '';
  return (
    (typeof code === 'string' && TLS_VERSION_ERRORS.has(code)) ||
    /unsupported protocol|alert protocol version/i.test(message)
  );
}

/**
 * Whether the client verifies the wss:// server certificate. Verification is on
 * unless it is disabled explicitly: `verifyServerCertificate: false`, or
 * TLS_REJECT_UNAUTHORIZED set to `false` or `0` when the option is not given.
 */
export function resolveVerifyServerCertificate(
  option: boolean | undefined,
  env: string | undefined = process.env['TLS_REJECT_UNAUTHORIZED'],
): boolean {
  if (option != null) return option;
  const value = env?.trim().toLowerCase();
  return value !== 'false' && value !== '0';
}

/**
 * Host name check for a Central System / CSMS certificate: the standard check
 * first (its error always wins), then the rule that a wildcard name is not
 * accepted: OCPP 1.6 Security Whitepaper (AllowCentralSystemTLSWildcards false,
 * OCTT TC_078) and OCPP 2.1 SecurityCtrlr.AllowCSMSTLSWildcards (not
 * implemented, so false).
 */
export function checkCentralSystemIdentity(host: string, cert: PeerCertificate): Error | undefined {
  const standard = checkServerIdentity(host, cert);
  if (standard != null) return standard;
  // A certificate without a subject has no subject field at runtime.
  const subject: unknown = cert.subject;
  const cn: unknown =
    typeof subject === 'object' && subject !== null
      ? (subject as Record<string, unknown>)['CN']
      : undefined;
  const commonNames = (Array.isArray(cn) ? cn : [cn]).filter(
    (name): name is string => typeof name === 'string',
  );
  const altNames = (cert.subjectaltname ?? '')
    .split(', ')
    .filter((name) => name.startsWith('DNS:'))
    .map((name) => name.slice(4));
  if ([...commonNames, ...altNames].some((name) => name.includes('*'))) {
    return Object.assign(new Error(`Wildcard server certificate for ${host} is not accepted`), {
      code: 'ERR_TLS_CERT_WILDCARD',
    });
  }
  return undefined;
}

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
  /** Verify the server certificate on wss:// (see resolveVerifyServerCertificate). */
  verifyServerCertificate?: boolean | undefined;
  /**
   * Extra random delay (ms) added to the first reconnect attempt after a
   * connection loss. A fleet sets it so thousands of stations do not
   * reconnect at the same instant after a server restart. Default 0. Applies
   * only without a 2.1 back-off (see reconnectWaitMs).
   */
  reconnectSpreadMs?: number | undefined;
}

export type IncomingCallHandler = (
  messageId: string,
  action: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/**
 * OCPP 2.x reconnect back-off (Part 4 5.4): the first attempt after
 * waitMinimumMs plus a random value up to randomRangeMs; every failed attempt
 * doubles the back-off, at most repeatTimes times.
 */
export interface ReconnectBackOff {
  waitMinimumMs: number;
  randomRangeMs: number;
  repeatTimes: number;
}

const BASE_RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 300_000; // 5 minutes cap

/**
 * Wait (ms) before a reconnect attempt after a connection loss. backOffAttempt
 * counts the back-off attempts made so far in this loss (0 for the first).
 *
 * - With a 2.1 back-off (Part 4 5.4): RetryBackOffWaitMinimum doubled per failed
 *   attempt, at most RetryBackOffRepeatTimes times, plus a new random part up to
 *   RetryBackOffRandomRange. The station's own random range spreads a fleet, so
 *   spreadMs does not apply: an extra delay would break the spec's upper bound.
 * - Without one (1.6, no back-off in the spec): 2 s doubling up to 5 minutes, plus
 *   20% jitter, and a random part up to spreadMs on the first attempt.
 */
export function reconnectWaitMs(
  backOff: ReconnectBackOff | null,
  backOffAttempt: number,
  spreadMs: number,
  random: () => number = Math.random,
): number {
  if (backOff != null) {
    const doublings = Math.min(backOffAttempt, Math.max(0, backOff.repeatTimes));
    return backOff.waitMinimumMs * Math.pow(2, doublings) + random() * backOff.randomRangeMs;
  }
  const delay = Math.min(
    BASE_RECONNECT_DELAY_MS * Math.pow(2, backOffAttempt),
    MAX_RECONNECT_DELAY_MS,
  );
  const jitter = random() * delay * 0.2;
  const spread = backOffAttempt === 0 ? random() * spreadMs : 0;
  return delay + jitter + spread;
}

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
  private serverUrl: string;
  private password: string;
  private securityProfile: number;
  private beforeReconnectAttempt: ((attempt: number) => void) | null = null;
  private reconnectBackOff: (() => ReconnectBackOff | null) | null = null;
  private clientCert: string | undefined;
  private clientKey: string | undefined;
  // Trust anchors for the CSMS server certificate (installed CSMS root certificates).
  private trustAnchors: string[];
  private readonly verifyServerCertificate: boolean;
  private onServerCertificateRejected: ((err: Error) => void) | null = null;
  private onTlsVersionRejected: ((err: Error) => void) | null = null;
  private readonly reconnectSpreadMs: number;
  // Set by reconnectNow(): the wait (ms) before the next reconnect loop's first
  // attempt, replacing the backoff.
  private firstReconnectDelayMs: number | null = null;

  private static readonly CALL_TIMEOUT_MS = 30_000;

  constructor(options: OcppClientOptions) {
    this.serverUrl = options.serverUrl;
    this._stationId = options.stationId;
    this._protocol = options.ocppProtocol;
    this.password = options.password ?? 'password';
    this.securityProfile = options.securityProfile ?? 1;
    this.clientCert = options.clientCert;
    this.clientKey = options.clientKey;
    this.trustAnchors = options.caCert != null ? [options.caCert] : [];
    this.verifyServerCertificate = resolveVerifyServerCertificate(options.verifyServerCertificate);
    this.reconnectSpreadMs = options.reconnectSpreadMs ?? 0;
  }

  /** Called when a connection attempt fails because the server certificate was not accepted. */
  setServerCertificateRejectedHandler(handler: (err: Error) => void): void {
    this.onServerCertificateRejected = handler;
  }

  /** Called when a connection attempt fails because the server's TLS version is below 1.2. */
  setTlsVersionRejectedHandler(handler: (err: Error) => void): void {
    this.onTlsVersionRejected = handler;
  }

  /** Root certificates the CSMS server certificate must chain to, from the next connect. */
  setTrustAnchors(pems: string[]): void {
    this.trustAnchors = [...pems];
  }

  /**
   * True only while the socket is open. A socket that is closing (the server
   * sent a close frame, or a close is under way) is not connected: the 'close'
   * event that clears `connected` comes later, and a send in between would fail.
   */
  get isConnected(): boolean {
    return this.openSocket() != null;
  }

  private openSocket(): WebSocket | null {
    const ws = this.ws;
    return this.connected && ws != null && ws.readyState === WebSocket.OPEN ? ws : null;
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

  /** Connection settings used from the next connect (password, security profile, or client certificate change). */
  updateConnection(opts: {
    serverUrl?: string;
    password?: string;
    securityProfile?: number;
    clientCert?: string;
    clientKey?: string;
  }): void {
    if (opts.serverUrl != null) this.serverUrl = opts.serverUrl;
    if (opts.password != null) this.password = opts.password;
    if (opts.securityProfile != null) this.securityProfile = opts.securityProfile;
    if (opts.clientCert != null) this.clientCert = opts.clientCert;
    if (opts.clientKey != null) this.clientKey = opts.clientKey;
  }

  get connection(): { serverUrl: string; password: string; securityProfile: number } {
    return {
      serverUrl: this.serverUrl,
      password: this.password,
      securityProfile: this.securityProfile,
    };
  }

  /** Called before each reconnect attempt, so a station can fall back to another network profile. */
  setBeforeReconnectAttempt(handler: (attempt: number) => void): void {
    this.beforeReconnectAttempt = handler;
  }

  /**
   * Reconnect back-off from the station's device model, read before every
   * attempt. Without it (or when it returns null) the client uses its own
   * exponential back-off with a spread first attempt.
   */
  setReconnectBackOff(provider: () => ReconnectBackOff | null): void {
    this.reconnectBackOff = provider;
  }

  setDisconnectedHandler(handler: () => void): void {
    this.onDisconnectedCallback = handler;
  }

  connect(): Promise<void> {
    const url = `${this.serverUrl}/${this._stationId}`;

    // SP0: no auth headers. SP1/SP2: Basic Auth. SP3: client certificate (no password).
    // Every connection carries the simulator marker, so the CSMS can tell this
    // simulator from a real station that connects with the same identity.
    const headers: Record<string, string> = {
      [SIMULATOR_CONNECTION_HEADER]: SIMULATOR_CONNECTION_HEADER_VALUE,
    };
    if (this.securityProfile >= 1 && this.securityProfile < 3) {
      headers['authorization'] =
        'Basic ' + Buffer.from(`${this._stationId}:${this.password}`).toString('base64');
    }

    // WebSocket options: TLS for SP2/SP3, client cert for SP3
    const wsOptions: Record<string, unknown> = {
      headers,
      rejectUnauthorized: this.verifyServerCertificate,
      // OCPP 2.1 A00.FR.314, 1.6 Security Whitepaper: TLS 1.2 or above.
      minVersion: 'TLSv1.2',
    };
    if (this.verifyServerCertificate) {
      wsOptions['checkServerIdentity'] = checkCentralSystemIdentity;
    }
    if (this.trustAnchors.length > 0) wsOptions['ca'] = this.trustAnchors;
    if (this.securityProfile === 3) {
      if (this.clientCert != null) wsOptions['cert'] = this.clientCert;
      if (this.clientKey != null) wsOptions['key'] = this.clientKey;
    }

    // An explicit connect after disconnect() (the station comes back online)
    // turns automatic reconnection back on.
    this.destroyed = false;

    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, [this._protocol], wsOptions);
      this.ws = socket;

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
        // The close of a socket that disconnect() dropped can arrive after a
        // newer connection opened: it says nothing about the current one.
        if (this.ws != null && this.ws !== socket) return;
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
          if (isServerCertificateError(err)) this.onServerCertificateRejected?.(err);
          else if (isTlsVersionError(err)) this.onTlsVersionRejected?.(err);
          reject(err);
        }
      });
    });
  }

  sendCall(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = this.openSocket();
      if (ws == null) {
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

      ws.send(JSON.stringify(call), (err) => {
        if (err != null) {
          clearTimeout(timeout);
          this.pending.delete(messageId);
          reject(err);
        }
      });
    });
  }

  /**
   * OCPP 2.1 SEND (MessageTypeId 6, Part 4 4.2.4): an unconfirmed message that
   * expects no response, e.g. NotifyPeriodicEventStream. Returns false when
   * not connected (nothing is sent).
   */
  sendSend(action: string, payload: Record<string, unknown>): boolean {
    const ws = this.openSocket();
    if (ws == null) return false;
    ws.send(JSON.stringify([6, randomUUID(), action, payload]));
    return true;
  }

  sendCallResult(messageId: string, payload: Record<string, unknown>): void {
    const ws = this.openSocket();
    if (ws == null) return;
    const result: OcppCallResult = [3, messageId, payload];
    ws.send(JSON.stringify(result));
  }

  sendCallError(messageId: string, errorCode: string, errorDescription?: string): void {
    const ws = this.openSocket();
    if (ws == null) return;
    const callError = [4, messageId, errorCode, errorDescription ?? '', {}];
    ws.send(JSON.stringify(callError));
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

  /**
   * Simulate a connection loss (close WS but allow auto-reconnect).
   */
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

  /**
   * Drop the connection and reconnect without the backoff wait, as a station
   * does when it comes back up after a reboot or power cycle. delayMs is how
   * long the station stays down before it connects again.
   */
  reconnectNow(delayMs = 0): void {
    if (this.ws == null) return;
    this.firstReconnectDelayMs = Math.max(0, delayMs);
    this.simulateConnectionLoss();
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

    const firstDelayMs = this.firstReconnectDelayMs;
    this.firstReconnectDelayMs = null;
    let attempt = 0;
    // Back-off attempts so far (the reconnect after a reboot is not one).
    let backOffAttempt = 0;

    while (!this.destroyed) {
      attempt++;

      let waitMs: number;
      if (firstDelayMs != null && attempt === 1) {
        // reconnectNow(): the station comes back up after a reboot or power-off.
        waitMs = firstDelayMs;
      } else {
        const backOff = this.reconnectBackOff?.() ?? null;
        waitMs = reconnectWaitMs(backOff, backOffAttempt, this.reconnectSpreadMs);
        backOffAttempt++;
      }

      console.log(
        `[${this._stationId}] Reconnect attempt ${String(attempt)} in ${String(Math.round(waitMs))}ms...`,
      );

      await new Promise((r) => setTimeout(r, waitMs));

      // Re-check after async wait (destroyed may change during sleep)
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (this.destroyed) break;

      this.beforeReconnectAttempt?.(attempt);
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
    const parsed = tryParseJson(raw);
    if (parsed === undefined) {
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
          `[${this._stationId}] No incoming call handler registered, answering ${action} with NotImplemented`,
        );
        this.sendCallError(messageId, 'NotImplemented', `${action} NotImplemented`);
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
