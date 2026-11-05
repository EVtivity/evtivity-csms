// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The WebSocket endpoint of the bus depot interface (VDV 463 1.1.0) on the
// API server, path /vdv463. The upgrade is refused unless it came over TLS
// (behind a trusted proxy: X-Forwarded-Proto https), the interface is on, the
// depot system signs in with HTTP Basic (presystem id and password) and is not
// locked. One live connection per depot system: a new one replaces the older,
// on this process directly and on the other API processes through the
// depot_system_changed channel (features/vdv-463.md).

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import proxyAddr from '@fastify/proxy-addr';
import { WebSocketServer } from 'ws';
import {
  clearVdv463SettingCache,
  getDepotSystem,
  getDepotSystemByPresystemId,
  isVdv463Enabled,
  recordDepotSystemAuthFailure,
  recordDepotSystemBoot,
  recordDepotSystemConnected,
  recordDepotSystemMessage,
  type DepotSystem,
} from '@evtivity/database';
import type { PubSubClient, ServiceLogger, Subscription } from '@evtivity/lib';
import { clientAddressKey } from '@evtivity/lib/ip-address';
import { lastForwardedProto } from '@evtivity/lib/trust-proxy';
import {
  VDV463_CLOSE_DISABLED,
  VDV463_CLOSE_NO_PROTOCOL,
  VDV463_CLOSE_REPLACED,
  VDV463_MAX_FRAME_BYTES,
  VDV463_PATH,
  VDV463_SUBPROTOCOLS,
  type DepotSnapshot,
  type Vdv463ChargingRequest,
} from '@evtivity/lib/vdv463';
import { verifyDepotSystemPassword } from '../lib/depot-system-password.js';
import { DEPOT_SYSTEM_CHANGED_CHANNEL } from '../lib/depot-system-channel.js';
import { auditDepotSystemAuthLock } from '../services/depot-system-requests.js';
import {
  depotSystemAuthLocksTotal,
  depotSystemConnections,
  depotSystemSignInsTotal,
} from '../plugins/metrics.js';
import {
  VDV463_ADDRESS_LOCK_FAILURES,
  addressWaiting,
  failureKey,
  memoryFailureStore,
  type AuthFailureStore,
} from './auth-failures.js';
import { Vdv463Connection, type ConnectionDeps } from './connection.js';

/**
 * The system-wide ceiling: failed sign-ins of one depot system from every
 * address before addresses with failures of their own are held back for the
 * lock time (an address without failures is still checked).
 */
export const VDV463_AUTH_LOCK_THRESHOLD = 100;
export const VDV463_AUTH_LOCK_MS = 15 * 60_000;
/** Sign-in attempts per client address and minute. */
export const VDV463_UPGRADES_PER_ADDRESS_MINUTE = 20;
/** Client addresses counted at once; past it a new address waits for the minute to end. */
export const VDV463_TRACKED_ADDRESSES = 10_000;
/** Password checks running at once per process; more answer 503 (security review M2). */
export const VDV463_MAX_PENDING_SIGN_INS = 16;
/** An upgrade must finish its sign-in within this time, else the socket closes. */
export const VDV463_HANDSHAKE_TIMEOUT_MS = 10_000;

export interface Vdv463ServerDeps {
  log: ServiceLogger;
  pubsub: PubSubClient;
  /** The API's TRUST_PROXY (false or a comma separated list). */
  trustProxy: false | string;
  /** development and test accept plain ws (no TLS in front). */
  allowPlain: boolean;
  readSnapshot: (systemId: string, presystemId: string, now: Date) => Promise<DepotSnapshot[]>;
  applyRequests: (system: DepotSystem, list: Vdv463ChargingRequest[]) => Promise<unknown>;
  /** Failed sign-ins per depot system and client address (Redis across processes). */
  failures?: AuthFailureStore;
  auditLock?: typeof auditDepotSystemAuthLock;
  now?: () => Date;
  timers?: Pick<ConnectionDeps, 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'>;
}

export interface Vdv463ServerHandle {
  close: () => Promise<void>;
  /** Connections on this process, by depot system id (tests and the live state). */
  connections: () => Map<string, Vdv463Connection>;
}

interface Attempts {
  windowStart: number;
  count: number;
}

function reject(
  socket: Duplex,
  status: number,
  text: string,
  headers: Record<string, string> = {},
): void {
  const lines = [`HTTP/1.1 ${String(status)} ${text}`, 'Connection: close', 'Content-Length: 0'];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  try {
    socket.end(`${lines.join('\r\n')}\r\n\r\n`);
  } catch {
    // fail-open: the client already went away, nothing to answer
    socket.destroy();
  }
}

/** HTTP Basic credentials, or null when the header is missing or not Basic. */
export function basicCredentials(
  header: string | undefined,
): { user: string; password: string } | null {
  if (header == null) return null;
  const match = /^basic\s+(\S+)\s*$/i.exec(header);
  if (match?.[1] == null) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    // fail-open: an undecodable header is no credential, the upgrade answers 401
    return null;
  }
  const at = decoded.indexOf(':');
  if (at <= 0) return null;
  return { user: decoded.slice(0, at), password: decoded.slice(at + 1) };
}

/** The subprotocol to answer: the highest this server speaks that the client offered. */
export function pickSubprotocol(offered: ReadonlySet<string>): string | false {
  for (const p of VDV463_SUBPROTOCOLS) if (offered.has(p)) return p;
  return false;
}

export function attachVdv463Server(server: Server, deps: Vdv463ServerDeps): Vdv463ServerHandle {
  const now = deps.now ?? (() => new Date());
  const timers = deps.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => {
      clearTimeout(t);
    },
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (t) => {
      clearInterval(t);
    },
  };
  const trusted =
    deps.trustProxy === false
      ? () => false
      : proxyAddr.compile(
          deps.trustProxy
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s !== ''),
        );
  const live = new Map<string, Vdv463Connection>();
  const failures = deps.failures ?? memoryFailureStore();
  const auditLock = deps.auditLock ?? auditDepotSystemAuthLock;
  const attempts = new Map<string, Attempts>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: VDV463_MAX_FRAME_BYTES,
    handleProtocols: (offered) => pickSubprotocol(offered),
    perMessageDeflate: false,
  });

  const clientIp = (req: IncomingMessage): string => {
    const peer = req.socket.remoteAddress ?? '';
    if (deps.trustProxy === false) return peer;
    return proxyAddr(req, trusted);
  };

  const secure = (req: IncomingMessage): boolean => {
    if ((req.socket as { encrypted?: boolean }).encrypted === true) return true;
    const peer = req.socket.remoteAddress ?? '';
    if (deps.trustProxy !== false && trusted(peer, 0)) {
      // The last entry, as Fastify reads request.protocol (security review PLAT-L1).
      const proto = lastForwardedProto(req.headers['x-forwarded-proto']);
      if (proto === 'https' || proto === 'wss') return true;
    }
    return deps.allowPlain;
  };

  const overAddressLimit = (ip: string): boolean => {
    const key = clientAddressKey(ip);
    const nowMs = now().getTime();
    const entry = attempts.get(key);
    if (entry == null || nowMs - entry.windowStart >= 60_000) {
      if (entry == null && attempts.size >= VDV463_TRACKED_ADDRESSES) {
        for (const [k, v] of attempts) if (nowMs - v.windowStart >= 60_000) attempts.delete(k);
        // Still full: every slot was used this minute, so a new address waits.
        if (attempts.size >= VDV463_TRACKED_ADDRESSES) return true;
      }
      attempts.set(key, { windowStart: nowMs, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > VDV463_UPGRADES_PER_ADDRESS_MINUTE;
  };

  const connectionDeps = (): ConnectionDeps => ({
    log: deps.log,
    now,
    readSnapshot: deps.readSnapshot,
    applyRequests: deps.applyRequests,
    recordBoot: recordDepotSystemBoot,
    recordMessage: recordDepotSystemMessage,
    recheck: async (systemId) => {
      if (!(await isVdv463Enabled())) return null;
      const row = await getDepotSystem(systemId);
      return row?.isEnabled === true ? row : null;
    },
    ...timers,
    onClosed: (c) => {
      if (live.get(c.systemId) === c) live.delete(c.systemId);
      depotSystemConnections.set(live.size);
    },
  });

  const lockAudited = (
    system: DepotSystem,
    lock: Parameters<typeof auditDepotSystemAuthLock>[1],
  ): void => {
    deps.log.warn({ depotSystemId: system.id, ...lock }, 'Depot system sign-in locked');
    depotSystemAuthLocksTotal.inc({ scope: lock.scope });
    void auditLock(system, lock, deps.log).catch((err: unknown) => {
      deps.log.warn({ err, depotSystemId: system.id }, 'Depot system sign-in lock not audited');
    });
  };

  // Failures count per depot system and client address: guesses from one
  // address make that address wait (doubling), never another one. The
  // system-wide ceiling holds back only addresses with failures of their own,
  // so a correct password from a clean address still signs in.
  const authenticate = async (req: IncomingMessage, ip: string): Promise<DepotSystem | null> => {
    const credentials = basicCredentials(req.headers.authorization);
    if (credentials == null) {
      depotSystemSignInsTotal.inc({ result: 'no_credentials' });
      return null;
    }
    const system = await getDepotSystemByPresystemId(credentials.user);
    const nowMs = now().getTime();
    const key = system != null ? failureKey(system.id, ip) : null;
    const own = key != null ? await failures.read(key, nowMs) : { count: 0, lastFailMs: 0 };
    const ceiling = system?.authLockedUntil != null && system.authLockedUntil.getTime() > nowMs;
    const held = addressWaiting(own, nowMs) || (ceiling && own.count > 0);
    // Unknown systems and held addresses spend the time of a check too.
    const ok = await verifyDepotSystemPassword(
      system != null && !held ? system.passwordHash : null,
      credentials.password,
    );
    if (system == null || key == null) {
      depotSystemSignInsTotal.inc({ result: 'unknown_system' });
      return null;
    }
    if (held) {
      depotSystemSignInsTotal.inc({ result: 'waiting' });
      return null;
    }
    if (!ok) {
      depotSystemSignInsTotal.inc({ result: 'wrong_password' });
      const count = await failures.fail(key, nowMs);
      if (count === VDV463_ADDRESS_LOCK_FAILURES) {
        lockAudited(system, {
          scope: 'address',
          addressKey: clientAddressKey(ip),
          failures: count,
        });
      }
      const systemLocked = await recordDepotSystemAuthFailure(
        system.id,
        VDV463_AUTH_LOCK_THRESHOLD,
        VDV463_AUTH_LOCK_MS,
      );
      if (systemLocked) {
        lockAudited(system, {
          scope: 'system',
          addressKey: clientAddressKey(ip),
          failures: VDV463_AUTH_LOCK_THRESHOLD,
        });
      }
      return null;
    }
    // A disabled system answers like a wrong password, after the same check, so
    // the timing does not tell them apart. No counter is cleared and no
    // connection is recorded (security review AUTH-L2).
    if (!system.isEnabled) {
      depotSystemSignInsTotal.inc({ result: 'disabled' });
      return null;
    }
    await failures.clear(key);
    await recordDepotSystemConnected(system.id);
    depotSystemSignInsTotal.inc({ result: 'ok' });
    return system;
  };

  let pendingSignIns = 0;

  const onUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    const ip = clientIp(req);
    if (!secure(req)) {
      deps.log.warn({ ip }, 'Depot system connection over plain HTTP refused');
      depotSystemSignInsTotal.inc({ result: 'plain_http' });
      reject(socket, 403, 'Forbidden');
      return;
    }
    if (overAddressLimit(ip)) {
      depotSystemSignInsTotal.inc({ result: 'rate_limited' });
      reject(socket, 429, 'Too Many Requests');
      return;
    }
    if (!(await isVdv463Enabled())) {
      depotSystemSignInsTotal.inc({ result: 'interface_off' });
      reject(socket, 503, 'Service Unavailable');
      return;
    }
    // Every check runs one argon2 verify: a bounded number at once per process.
    if (pendingSignIns >= VDV463_MAX_PENDING_SIGN_INS) {
      depotSystemSignInsTotal.inc({ result: 'busy' });
      reject(socket, 503, 'Service Unavailable');
      return;
    }
    pendingSignIns += 1;
    let system: DepotSystem | null;
    try {
      system = await authenticate(req, ip);
    } finally {
      pendingSignIns -= 1;
    }
    if (socket.destroyed) return;
    if (system == null) {
      deps.log.info({ ip }, 'Depot system sign-in refused');
      reject(socket, 401, 'Unauthorized', {
        'WWW-Authenticate': 'Basic realm="vdv463", charset="UTF-8"',
      });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (ws.protocol === '') {
        // No subprotocol in common: the handshake completes without one and the
        // connection closes (VDV 463, section 3.1.3).
        ws.close(VDV463_CLOSE_NO_PROTOCOL, 'No supported subprotocol');
        return;
      }
      const previous = live.get(system.id);
      if (previous != null) previous.close(VDV463_CLOSE_REPLACED, 'Replaced by a newer connection');
      const connection = new Vdv463Connection(ws, system, connectionDeps());
      live.set(system.id, connection);
      depotSystemConnections.set(live.size);
      deps.log.info({ depotSystemId: system.id, ip }, 'Depot system connected');
      void deps.pubsub
        .publish(
          DEPOT_SYSTEM_CHANGED_CHANNEL,
          JSON.stringify({ id: system.id, kickExcept: connection.id }),
        )
        .catch((err: unknown) => {
          deps.log.warn(
            { err, depotSystemId: system.id },
            'Depot system connection not announced to the other processes',
          );
        });
    });
  };

  const listener = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = (req.url ?? '').split('?')[0];
    // The only upgrade listener of the API server: Node hands every upgrade to
    // it and no longer times the socket out, so another path is answered and
    // closed here (security review M1).
    if (path !== VDV463_PATH && path !== `${VDV463_PATH}/`) {
      reject(socket, 404, 'Not Found');
      return;
    }
    const timer = setTimeout(() => {
      if (!socket.destroyed) socket.destroy();
    }, VDV463_HANDSHAKE_TIMEOUT_MS);
    socket.once('close', () => {
      clearTimeout(timer);
    });
    void onUpgrade(req, socket, head)
      .catch((err: unknown) => {
        deps.log.error({ err }, 'Depot system connection failed');
        if (!socket.destroyed) reject(socket, 500, 'Internal Server Error');
      })
      .finally(() => {
        clearTimeout(timer);
      });
  };
  server.on('upgrade', listener);

  // Other processes: a newer connection elsewhere replaces ours; a changed
  // system reloads, or closes when it was disabled, retyped, lost a site,
  // got a new password or was deleted.
  let subscription: Subscription | null = null;
  void deps.pubsub
    .subscribe(DEPOT_SYSTEM_CHANGED_CHANNEL, (message: string) => {
      let event: { id?: unknown; kickExcept?: unknown; close?: unknown; all?: unknown };
      try {
        event = JSON.parse(message) as typeof event;
      } catch {
        // fail-open: a malformed event changes no connection
        return;
      }
      // The interface switch changed: the setting is read again here, and
      // every connection closes when it is off.
      if (event.all === true) {
        clearVdv463SettingCache();
        void isVdv463Enabled()
          .then((on) => {
            if (on) return;
            for (const c of [...live.values()]) {
              c.close(VDV463_CLOSE_DISABLED, 'The depot interface is off');
            }
          })
          .catch((err: unknown) => {
            deps.log.warn({ err }, 'Depot interface switch not read, connections recheck it');
          });
        return;
      }
      if (typeof event.id !== 'string') return;
      const connection = live.get(event.id);
      if (connection == null) return;
      if (typeof event.kickExcept === 'string') {
        if (event.kickExcept !== connection.id) {
          connection.close(VDV463_CLOSE_REPLACED, 'Replaced by a newer connection');
        }
        return;
      }
      if (event.close === true) {
        connection.close(VDV463_CLOSE_DISABLED, 'The depot system changed');
        return;
      }
      void getDepotSystem(event.id)
        .then((row) => {
          if (row == null || !row.isEnabled)
            connection.close(VDV463_CLOSE_DISABLED, 'The depot system changed');
          else connection.reload(row);
        })
        .catch((err: unknown) => {
          deps.log.warn({ err, depotSystemId: event.id }, 'Depot system not reloaded');
        });
    })
    .then((s) => {
      subscription = s;
    })
    .catch((err: unknown) => {
      deps.log.error({ err }, 'Depot system change channel not subscribed');
    });

  return {
    connections: () => live,
    close: async () => {
      server.off('upgrade', listener);
      for (const c of [...live.values()]) c.close(1001, 'Server shutting down');
      live.clear();
      depotSystemConnections.set(0);
      wss.close();
      if (subscription != null) await subscription.unsubscribe();
    },
  };
}
