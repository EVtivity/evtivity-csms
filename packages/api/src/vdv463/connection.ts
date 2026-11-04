// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// One depot system connection of the bus depot interface (VDV 463 1.1.0):
// the BootNotification, the depot system's charging request lists, the
// charging information EVtivity sends at the system's interval, one request
// outstanding per sender with its wait and retries, and the keepalive.

import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { DepotSystem } from '@evtivity/database';
import {
  VDV463_CLOSE_DISABLED,
  VDV463_CLOSE_NOT_CONFIRMED,
  VDV463_CLOSE_RATE,
  VDV463_CLOSE_REJECTED,
  VDV463_CLOSE_SILENT,
  VDV463_CONFIRMATION,
  VDV463_CONFIRMATION_SCHEMAS,
  VDV463_ERROR,
  VDV463_MAX_MESSAGES_PER_MINUTE,
  VDV463_PING_INTERVAL_MS,
  VDV463_REQUEST,
  VDV463_REQUEST_SCHEMAS,
  buildChargingInformation,
  parseVdv463Frame,
  vdv463ErrorFrame,
  vdv463ErrorText,
  vdv463PayloadProblem,
  writeVdv463Frame,
  type DepotSnapshot,
  type Vdv463ChargingRequest,
  type Vdv463Frame,
} from '@evtivity/lib/vdv463';

export interface ConnectionLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface ConnectionDeps {
  log: ConnectionLogger;
  now: () => Date;
  readSnapshot: (systemId: string, presystemId: string, now: Date) => Promise<DepotSnapshot[]>;
  applyRequests: (system: DepotSystem, list: Vdv463ChargingRequest[]) => Promise<unknown>;
  recordBoot: (systemId: string) => Promise<void>;
  recordMessage: (systemId: string) => Promise<void>;
  /**
   * The interface is on and the stored system is enabled, read again before
   * each request is applied and each charging information is sent (the kill
   * switch: false closes the connection). Returns the stored row, or null.
   */
  recheck: (systemId: string) => Promise<DepotSystem | null>;
  /** Timer functions (tests pass fake ones). */
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (t: ReturnType<typeof setTimeout>) => void;
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (t: ReturnType<typeof setInterval>) => void;
  onClosed: (connection: Vdv463Connection) => void;
}

interface Outstanding {
  messageId: string;
  frame: string;
  attempts: number;
  timer: ReturnType<typeof setTimeout>;
}

export class Vdv463Connection {
  readonly id = randomUUID();
  private booted = false;
  private outstanding: Outstanding | null = null;
  private infoTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivityMs: number;
  private messageTimes: number[] = [];
  private lastRequestId: string | null = null;
  private applyChain: Promise<void> = Promise.resolve();
  /** The newest list waiting while another applies (at most one: a list is the whole state). */
  private queued: { frame: Vdv463Frame; list: Vdv463ChargingRequest[] } | null = null;
  private applying = false;
  /** What the connection signed in with: a new password or type ends it. */
  private readonly signedInHash: string;
  private readonly signedInType: string;
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private system: DepotSystem,
    private readonly deps: ConnectionDeps,
  ) {
    this.lastActivityMs = deps.now().getTime();
    this.signedInHash = system.passwordHash;
    this.signedInType = system.systemType;
    ws.on('message', (data, isBinary) => {
      this.onMessage(data, isBinary);
    });
    ws.on('ping', () => {
      this.touch();
    });
    ws.on('pong', () => {
      this.touch();
    });
    ws.on('close', () => {
      this.cleanup();
    });
    ws.on('error', (err) => {
      this.deps.log.warn({ err, depotSystemId: this.system.id }, 'Depot system connection error');
    });
    this.pingTimer = deps.setInterval(() => {
      this.keepalive();
    }, VDV463_PING_INTERVAL_MS);
  }

  get systemId(): string {
    return this.system.id;
  }

  get isBooted(): boolean {
    return this.booted;
  }

  /** The stored row changed: new intervals and limits apply from now. */
  reload(system: DepotSystem): void {
    this.system = system;
    if (this.booted) this.startInfoTimer();
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close(code, reason);
    } catch (err: unknown) {
      this.deps.log.warn(
        { err, depotSystemId: this.system.id },
        'Depot system connection close failed',
      );
      this.ws.terminate();
    }
    this.cleanup();
  }

  private touch(): void {
    this.lastActivityMs = this.deps.now().getTime();
  }

  private keepalive(): void {
    const silentMs = this.deps.now().getTime() - this.lastActivityMs;
    if (silentMs > this.system.keepaliveTimeoutSeconds * 1000) {
      this.deps.log.info(
        { depotSystemId: this.system.id, silentMs },
        'Depot system silent, connection closed',
      );
      this.close(VDV463_CLOSE_SILENT, 'No message or ping within the keepalive time');
      return;
    }
    try {
      this.ws.ping();
    } catch (err: unknown) {
      this.deps.log.warn({ err, depotSystemId: this.system.id }, 'Depot system ping failed');
    }
  }

  private send(text: string): void {
    if (this.closed) return;
    this.ws.send(text);
  }

  private sendError(messageId: string, action: string, text: string): void {
    this.send(vdv463ErrorFrame(this.system.presystemId, messageId, action, text, this.deps.now()));
  }

  private sendConfirmation(frame: Vdv463Frame, payload: unknown): void {
    this.send(
      writeVdv463Frame({
        type: VDV463_CONFIRMATION,
        presystemId: this.system.presystemId,
        timestamp: this.deps.now(),
        messageId: frame.messageId,
        action: frame.action,
        payload,
      }),
    );
  }

  /** Over the message rate: the connection closes (a flood is not answered). */
  private overRate(): boolean {
    const nowMs = this.deps.now().getTime();
    this.messageTimes = this.messageTimes.filter((t) => nowMs - t < 60_000);
    this.messageTimes.push(nowMs);
    return this.messageTimes.length > VDV463_MAX_MESSAGES_PER_MINUTE;
  }

  private onMessage(data: unknown, isBinary: boolean): void {
    this.touch();
    if (this.overRate()) {
      this.deps.log.warn(
        { depotSystemId: this.system.id },
        'Depot system over the message rate, closed',
      );
      this.close(VDV463_CLOSE_RATE, 'Too many messages');
      return;
    }
    void this.deps.recordMessage(this.system.id).catch((err: unknown) => {
      this.deps.log.warn(
        { err, depotSystemId: this.system.id },
        'Depot system message time not stored',
      );
    });
    if (isBinary) {
      this.sendError(randomUUID(), 'Unknown', 'Messages are JSON text frames');
      return;
    }
    const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    const parsed = parseVdv463Frame(raw);
    if (!parsed.ok) {
      // The error confirms the request; an answer to an error frame is never sent.
      if (parsed.type === VDV463_ERROR) return;
      const reason =
        parsed.reason === 'unknown_action'
          ? 'Unknown message action'
          : parsed.reason === 'invalid_json'
            ? 'The message is not valid JSON'
            : 'The message is not a valid VDV 463 frame';
      this.sendError(parsed.messageId ?? randomUUID(), parsed.action ?? 'Unknown', reason);
      return;
    }
    const frame = parsed.frame;
    if (frame.presystemId !== this.system.presystemId) {
      if (frame.type === VDV463_REQUEST) {
        this.sendError(
          frame.messageId,
          frame.action,
          'PresystemId does not match the signed-in depot system',
        );
      }
      return;
    }
    if (frame.type === VDV463_REQUEST) this.onRequest(frame);
    else if (frame.type === VDV463_CONFIRMATION) this.onConfirmation(frame);
    else this.onErrorFrame(frame);
  }

  private onRequest(frame: Vdv463Frame): void {
    if (frame.action === 'ProvideChargingInformation') {
      this.sendError(
        frame.messageId,
        frame.action,
        'Only the charging management system sends this request',
      );
      return;
    }
    const schema = VDV463_REQUEST_SCHEMAS[frame.action];
    const payload = schema.safeParse(frame.payload);
    if (!payload.success) {
      this.sendError(frame.messageId, frame.action, vdv463PayloadProblem(payload.error));
      return;
    }
    if (frame.action === 'BootNotification') {
      this.whenAllowed(() => {
        this.onBoot(frame, payload.data as { presystem: string });
      });
      return;
    }
    if (!this.booted) {
      this.sendError(frame.messageId, frame.action, 'Send a BootNotification first');
      return;
    }
    // A request resent with the same message id is confirmed again, applied once.
    if (frame.messageId === this.lastRequestId) {
      this.sendConfirmation(frame, {});
      return;
    }
    this.lastRequestId = frame.messageId;
    const list = (payload.data as { chargingRequestList: Vdv463ChargingRequest[] })
      .chargingRequestList;
    // A list is the depot system's whole state: one waiting while another
    // applies is replaced by the newer one, so the queue never grows
    // (security review M3). The replaced list is confirmed as received.
    if (this.queued != null) this.sendConfirmation(this.queued.frame, {});
    this.queued = { frame, list };
    void this.drainLists();
  }

  /** Applies the waiting list, one at a time, each after the recheck. */
  private async drainLists(): Promise<void> {
    if (this.applying) return;
    this.applying = true;
    try {
      for (;;) {
        const next = this.queued;
        if (next == null) return;
        this.queued = null;
        let system: DepotSystem | null;
        try {
          system = await this.allowedSystem();
        } catch (err: unknown) {
          this.deps.log.error(
            { err, depotSystemId: this.system.id },
            'Depot system recheck failed, the list is not applied',
          );
          continue;
        }
        if (system == null) return;
        // The confirmation says the list was received; it is applied after it.
        this.sendConfirmation(next.frame, {});
        try {
          await this.deps.applyRequests(system, next.list);
        } catch (err: unknown) {
          this.deps.log.error(
            { err, depotSystemId: system.id, requests: next.list.length },
            'Depot system charging requests not applied, the next list applies them',
          );
        }
      }
    } finally {
      this.applying = false;
    }
  }

  /**
   * The stored system when the interface is on and the system enabled; else
   * the connection closes and null is returned (nothing is answered or applied).
   */
  private async allowedSystem(): Promise<DepotSystem | null> {
    if (this.closed) return null;
    const row = await this.deps.recheck(this.system.id);
    // The connection may have closed while the recheck read.
    if (this.isClosed()) return null;
    if (
      row != null &&
      (row.passwordHash !== this.signedInHash || row.systemType !== this.signedInType)
    ) {
      // A new password or type closes the connection even when the change
      // event was lost (security review L1): it signs in again.
      this.deps.log.info(
        { depotSystemId: this.system.id },
        'Depot system password or type changed, connection closed',
      );
      this.close(VDV463_CLOSE_DISABLED, 'The depot system changed');
      return null;
    }
    if (row?.isEnabled !== true) {
      this.deps.log.info(
        { depotSystemId: this.system.id },
        'Depot interface off or depot system disabled, connection closed',
      );
      this.close(VDV463_CLOSE_DISABLED, 'The depot interface or depot system is off');
      return null;
    }
    this.system = row;
    return row;
  }

  /** Runs `fn` in order with the other requests once the recheck allows it. */
  private whenAllowed(fn: () => void): void {
    this.applyChain = this.applyChain
      .then(async () => {
        if ((await this.allowedSystem()) != null) fn();
      })
      .catch((err: unknown) => {
        this.deps.log.error({ err, depotSystemId: this.system.id }, 'Depot system request failed');
      });
  }

  private onBoot(frame: Vdv463Frame, payload: { presystem: string }): void {
    // A disabled system never gets here: the sign-in refuses it (AUTH-L2) and
    // the recheck before this boot closes the connection (AUTH-I4).
    const accepted = payload.presystem === this.system.systemType;
    this.sendConfirmation(frame, { status: accepted ? 'Accepted' : 'Rejected' });
    if (!accepted) {
      this.deps.log.info(
        { depotSystemId: this.system.id, presystem: payload.presystem },
        'Depot system BootNotification rejected',
      );
      this.close(VDV463_CLOSE_REJECTED, 'BootNotification rejected');
      return;
    }
    this.booted = true;
    void this.deps.recordBoot(this.system.id).catch((err: unknown) => {
      this.deps.log.warn(
        { err, depotSystemId: this.system.id },
        'Depot system boot time not stored',
      );
    });
    this.startInfoTimer();
    void this.sendInformation();
  }

  private onConfirmation(frame: Vdv463Frame): void {
    const out = this.outstanding;
    if (out == null || out.messageId !== frame.messageId) {
      this.deps.log.info(
        { depotSystemId: this.system.id, messageId: frame.messageId },
        'Unexpected depot system confirmation',
      );
      return;
    }
    const schema = VDV463_CONFIRMATION_SCHEMAS[frame.action];
    if (!schema.safeParse(frame.payload).success) {
      this.deps.log.warn(
        { depotSystemId: this.system.id, action: frame.action },
        'Depot system confirmation with an unexpected payload',
      );
    }
    this.deps.clearTimeout(out.timer);
    this.outstanding = null;
  }

  private onErrorFrame(frame: Vdv463Frame): void {
    const out = this.outstanding;
    this.deps.log.warn(
      {
        depotSystemId: this.system.id,
        messageId: frame.messageId,
        error: vdv463ErrorText(frame.payload).slice(0, 300),
      },
      'Depot system answered with an error',
    );
    // An error frame confirms the request it answers.
    if (out != null && out.messageId === frame.messageId) {
      this.deps.clearTimeout(out.timer);
      this.outstanding = null;
    }
  }

  private startInfoTimer(): void {
    if (this.infoTimer != null) this.deps.clearInterval(this.infoTimer);
    this.infoTimer = this.deps.setInterval(() => {
      void this.sendInformation();
    }, this.system.infoIntervalSeconds * 1000);
  }

  /** One charging information request, unless one is still waiting for its confirmation. */
  async sendInformation(): Promise<void> {
    if (this.closed || !this.booted || this.outstanding != null) return;
    let payload;
    try {
      if ((await this.allowedSystem()) == null) return;
      const now = this.deps.now();
      payload = buildChargingInformation(
        await this.deps.readSnapshot(this.system.id, this.system.presystemId, now),
        now,
      );
    } catch (err: unknown) {
      this.deps.log.error(
        { err, depotSystemId: this.system.id },
        'Depot system charging information not built, this cycle is skipped',
      );
      return;
    }
    // The snapshot read awaited: the connection may have closed, or another
    // request gone out, meanwhile.
    if (this.isBusy()) return;
    const messageId = randomUUID();
    const frame = writeVdv463Frame({
      type: VDV463_REQUEST,
      presystemId: this.system.presystemId,
      timestamp: this.deps.now(),
      messageId,
      action: 'ProvideChargingInformation',
      payload,
    });
    this.outstanding = { messageId, frame, attempts: 1, timer: this.waitTimer(messageId) };
    this.send(frame);
  }

  private isClosed(): boolean {
    return this.closed;
  }

  private isBusy(): boolean {
    return this.closed || this.outstanding != null;
  }

  private waitTimer(messageId: string): ReturnType<typeof setTimeout> {
    return this.deps.setTimeout(() => {
      this.onWaitOver(messageId);
    }, this.system.requestTimeoutSeconds * 1000);
  }

  private onWaitOver(messageId: string): void {
    const out = this.outstanding;
    if (out == null || out.messageId !== messageId) return;
    if (out.attempts > this.system.maxRetries) {
      this.deps.log.warn(
        { depotSystemId: this.system.id, attempts: out.attempts },
        'Depot system did not confirm, connection closed',
      );
      this.outstanding = null;
      this.close(VDV463_CLOSE_NOT_CONFIRMED, 'No confirmation after the retries');
      return;
    }
    out.attempts += 1;
    out.timer = this.waitTimer(messageId);
    this.send(out.frame);
  }

  private cleanup(): void {
    this.closed = true;
    if (this.infoTimer != null) this.deps.clearInterval(this.infoTimer);
    if (this.pingTimer != null) this.deps.clearInterval(this.pingTimer);
    if (this.outstanding != null) this.deps.clearTimeout(this.outstanding.timer);
    this.infoTimer = null;
    this.pingTimer = null;
    this.outstanding = null;
    this.deps.onClosed(this);
  }
}
