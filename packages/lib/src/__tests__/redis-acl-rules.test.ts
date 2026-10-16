// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Keeps docker/redis/acl-rules.conf (the per-service Redis users) in lockstep
// with the code: a channel or key prefix used by a process but missing from
// its Redis user fails at runtime with NOPERM, which the pub/sub callers only
// log.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const RULES_FILE = join(ROOT, 'docker/redis/acl-rules.conf');

interface AclUser {
  keys: string[];
  readKeys: string[];
  channels: string[];
  commands: string[];
}

function parseRules(text: string): Map<string, AclUser> {
  const users = new Map<string, AclUser>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [keyword, name, ...rules] = line.split(/\s+/);
    if (keyword !== 'user' || name == null) throw new Error(`bad line: ${line}`);
    const user: AclUser = { keys: [], readKeys: [], channels: [], commands: [] };
    for (const rule of rules) {
      if (rule.startsWith('%R~')) user.readKeys.push(rule.slice(3));
      else if (rule.startsWith('~')) user.keys.push(rule.slice(1));
      else if (rule.startsWith('&')) user.channels.push(rule.slice(1));
      else if (rule.startsWith('+') || rule.startsWith('-')) user.commands.push(rule);
      else throw new Error(`unexpected rule "${rule}" for user ${name}`);
    }
    users.set(name, user);
  }
  return users;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === '__integration__') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

const CHANNEL_CONSTANT = /(\w*CHANNEL)\s*=\s*['"`]([a-z0-9_]+)['"`]/g;

/** The *CHANNEL constants @evtivity/lib exports, by name. */
const LIB_CHANNEL_CONSTANTS = new Map<string, string>();
for (const file of sourceFiles(join(ROOT, 'packages/lib/src'))) {
  for (const m of readFileSync(file, 'utf8').matchAll(CHANNEL_CONSTANT)) {
    LIB_CHANNEL_CONSTANTS.set(m[1] as string, m[2] as string);
  }
}

/** Lib helpers that publish on a fixed channel. */
const LIB_CHANNEL_HELPERS = new Map([['publishOcppCommand', 'ocpp_commands']]);

/**
 * Channel names passed as literals to publish/subscribe, held in *CHANNEL
 * constants, named through a lib *CHANNEL constant, or published by a lib helper.
 */
function channelsUsedBy(pkg: string): Set<string> {
  const channels = new Set<string>();
  const call = /\.(?:publish|subscribe)\(\s*['"`]([a-z0-9_]+)['"`]/g;
  for (const file of sourceFiles(join(ROOT, 'packages', pkg, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(call)) channels.add(m[1] as string);
    for (const m of text.matchAll(CHANNEL_CONSTANT)) channels.add(m[2] as string);
    for (const [name, channel] of [...LIB_CHANNEL_CONSTANTS, ...LIB_CHANNEL_HELPERS]) {
      if (new RegExp(`\\b${name}\\b`).test(text)) channels.add(channel);
    }
  }
  return channels;
}

function grantsKey(user: AclUser, key: string, mode: 'rw' | 'r'): boolean {
  const patterns = mode === 'r' ? [...user.keys, ...user.readKeys] : user.keys;
  return patterns.some((p) => (p.endsWith('*') ? key.startsWith(p.slice(0, -1)) : key === p));
}

const users = parseRules(readFileSync(RULES_FILE, 'utf8'));
const user = (name: string): AclUser => {
  const u = users.get(name);
  if (u == null) throw new Error(`no user ${name} in acl-rules.conf`);
  return u;
};
const CSS_CHANNELS = ['css_commands', 'css_command_results'];

describe('docker/redis/acl-rules.conf', () => {
  it('defines exactly the five service users', () => {
    expect([...users.keys()].sort()).toEqual(['api', 'css', 'ocpi', 'ocpp', 'worker']);
  });

  it('gives every user all commands except @dangerous, plus INFO, and no wildcard keys or channels', () => {
    for (const [name, u] of users) {
      expect(u.commands, name).toEqual(['+@all', '-@dangerous', '+info']);
      expect(u.keys, name).not.toContain('*');
      expect(u.readKeys, name).not.toContain('*');
      expect(u.channels, name).not.toContain('*');
    }
  });

  it('gives api, ocpp and worker the same core channel set (api adds only the simulator channels)', () => {
    const core = [...user('ocpp').channels].sort();
    expect([...user('worker').channels].sort()).toEqual(core);
    expect([...user('api').channels].sort()).toEqual([...core, ...CSS_CHANNELS].sort());
  });

  it('grants the core set every channel the core packages use', () => {
    const core = new Set(user('ocpp').channels);
    for (const pkg of ['ocpp', 'worker', 'lib', 'payments', 'database', 'services']) {
      for (const channel of channelsUsedBy(pkg)) {
        expect(core.has(channel), `${channel} (used in packages/${pkg})`).toBe(true);
      }
    }
    const api = new Set(user('api').channels);
    for (const channel of channelsUsedBy('api')) {
      expect(api.has(channel), `${channel} (used in packages/api)`).toBe(true);
    }
  });

  it('grants ocpi and css exactly the channels their packages use', () => {
    expect([...user('ocpi').channels].sort()).toEqual([...channelsUsedBy('ocpi')].sort());
    expect([...user('css').channels].sort()).toEqual([...channelsUsedBy('css')].sort());
  });

  it('finds the channels in the sources (the scan itself works)', () => {
    expect(channelsUsedBy('ocpp').has('ocpp_commands')).toBe(true);
    expect(channelsUsedBy('worker').has('reservation_schedule')).toBe(true);
    expect(channelsUsedBy('api').has('css_commands')).toBe(true);
  });

  it('grants the automatic insight request channel to the core set (TC-AI-C-13)', () => {
    // AI_INSIGHT_REQUESTS_CHANNEL in @evtivity/services, published by the API
    // and read by the worker bridge.
    expect(channelsUsedBy('services').has('ai_insight_requests')).toBe(true);
    for (const name of ['api', 'ocpp', 'worker']) {
      expect(user(name).channels, name).toContain('ai_insight_requests');
    }
    expect(user('ocpi').channels).not.toContain('ai_insight_requests');
  });

  it('TC-CFG-07 grants the driver AI request channel to api, ocpp and worker only', () => {
    // DRIVER_AI_REQUESTS_CHANNEL in @evtivity/lib/driver-ai, published by the
    // API and read by the worker bridge to the driver-ai queue.
    expect(LIB_CHANNEL_CONSTANTS.get('DRIVER_AI_REQUESTS_CHANNEL')).toBe('driver_ai_requests');
    expect(channelsUsedBy('lib').has('driver_ai_requests')).toBe(true);
    for (const name of ['api', 'ocpp', 'worker']) {
      expect(user(name).channels, name).toContain('driver_ai_requests');
    }
    for (const name of ['ocpi', 'css']) {
      expect(user(name).channels, name).not.toContain('driver_ai_requests');
    }
  });

  it('grants each process its keys and nothing outside them', () => {
    const watchKey = /PROCESS_VERSION_WATCH_KEY = '([^']+)'/.exec(
      readFileSync(join(ROOT, 'packages/database/src/lib/process-versions.ts'), 'utf8'),
    )?.[1];
    const registryPrefix = /KEY_PREFIX = '([^']+)'/.exec(
      readFileSync(join(ROOT, 'packages/lib/src/connection-registry.ts'), 'utf8'),
    )?.[1];
    const noncePrefix = /PREFIX = '([^']+)'/.exec(
      readFileSync(join(ROOT, 'packages/api/src/lib/device-attestation/challenge.ts'), 'utf8'),
    )?.[1];
    const aiRateLimitPrefix = /AI_RATE_LIMIT_KEY_PREFIX = '([^']+)'/.exec(
      readFileSync(join(ROOT, 'packages/api/src/services/ai/engine/limits.ts'), 'utf8'),
    )?.[1];
    expect(watchKey).toBeDefined();
    expect(registryPrefix).toBeDefined();
    expect(noncePrefix).toBeDefined();
    expect(aiRateLimitPrefix).toBeDefined();

    // BullMQ (prefix "bull"), the maintenance fan-out and station render locks, the watch key.
    expect(grantsKey(user('worker'), 'bull:cron-jobs:wait', 'rw')).toBe(true);
    expect(grantsKey(user('worker'), 'mfl:site-1', 'rw')).toBe(true);
    expect(grantsKey(user('worker'), 'sml:sta_1', 'rw')).toBe(true);
    // Worker locks: a cron job, a fleet billing fan-out, the conformance run.
    expect(grantsKey(user('worker'), 'wkl:cron:dashboard-snapshot', 'rw')).toBe(true);
    expect(grantsKey(user('worker'), 'wkl:fleet-billing:flt_1', 'rw')).toBe(true);
    expect(grantsKey(user('worker'), 'wkl:octt-run', 'rw')).toBe(true);
    expect(grantsKey(user('api'), 'wkl:octt-run', 'r')).toBe(false);
    expect(grantsKey(user('worker'), watchKey as string, 'rw')).toBe(true);
    // The connection registry belongs to ocpp; the worker's offline sweep reads it.
    expect(grantsKey(user('ocpp'), `${registryPrefix as string}CS-1`, 'rw')).toBe(true);
    expect(grantsKey(user('worker'), `${registryPrefix as string}CS-1`, 'r')).toBe(true);
    expect(grantsKey(user('worker'), `${registryPrefix as string}CS-1`, 'rw')).toBe(false);
    // Response cache and attestation nonces; the watch key read-only.
    expect(grantsKey(user('api'), 'rc:ver:stations', 'rw')).toBe(true);
    expect(grantsKey(user('api'), `${noncePrefix as string}abc`, 'rw')).toBe(true);
    // AI per-minute counters (user and site windows); a missing grant fails open.
    expect(grantsKey(user('api'), `${aiRateLimitPrefix as string}user:usr_1:1`, 'rw')).toBe(true);
    expect(grantsKey(user('api'), `${aiRateLimitPrefix as string}site:sit_1:1`, 'rw')).toBe(true);
    for (const name of ['ocpp', 'ocpi', 'worker', 'css']) {
      expect(grantsKey(user(name), `${aiRateLimitPrefix as string}user:usr_1:1`, 'r'), name).toBe(
        false,
      );
    }
    // Guest start velocity counters (per IP, one-hour windows); api only.
    const guestVelocityPrefix = /GUEST_VELOCITY_KEY_PREFIX = '([^']+)'/.exec(
      readFileSync(join(ROOT, 'packages/api/src/lib/guest-velocity.ts'), 'utf8'),
    )?.[1];
    expect(guestVelocityPrefix).toBeDefined();
    expect(grantsKey(user('api'), `${guestVelocityPrefix as string}start:1.2.3.4:1`, 'rw')).toBe(
      true,
    );
    expect(grantsKey(user('api'), `${guestVelocityPrefix as string}decline:1.2.3.4:1`, 'rw')).toBe(
      true,
    );
    for (const name of ['ocpp', 'ocpi', 'worker', 'css']) {
      expect(
        grantsKey(user(name), `${guestVelocityPrefix as string}start:1.2.3.4:1`, 'r'),
        name,
      ).toBe(false);
    }
    expect(grantsKey(user('api'), watchKey as string, 'r')).toBe(true);
    expect(grantsKey(user('api'), watchKey as string, 'rw')).toBe(false);
    // OCPI pull lock and its own BullMQ queue (ocpi-cdrs), no other queue.
    expect(grantsKey(user('ocpi'), 'opl:partner-1:locations', 'rw')).toBe(true);
    expect(grantsKey(user('ocpi'), 'bull:ocpi-cdrs:wait', 'rw')).toBe(true);
    // api and ocpp add jobs straight to the worker queues whose requests must
    // survive a stopped worker, and to no other queue.
    const producerQueues = {
      api: [
        'fleet-billing-fanout',
        'maintenance-fanout',
        'member-invoices',
        'payment-webhooks',
        'station-messages',
        'station-watch',
      ],
      ocpp: [
        'maintenance-fanout',
        'payment-stops',
        'payment-webhooks',
        'station-messages',
        'station-watch',
      ],
    };
    for (const [name, queues] of Object.entries(producerQueues)) {
      for (const queue of queues) {
        expect(grantsKey(user(name), `bull:${queue}:wait`, 'rw'), `${name} ${queue}`).toBe(true);
        expect(grantsKey(user(name), `bull:${queue}:id`, 'rw'), `${name} ${queue}`).toBe(true);
        // Debounced station message jobs use BullMQ deduplication keys.
        expect(grantsKey(user(name), `bull:${queue}:de:x`, 'rw'), `${name} ${queue}`).toBe(true);
      }
    }
    for (const queue of ['fleet-invoices', 'reservations', 'reports', 'ai-insights']) {
      expect(grantsKey(user('api'), `bull:${queue}:wait`, 'r'), queue).toBe(false);
      expect(grantsKey(user('ocpp'), `bull:${queue}:wait`, 'r'), queue).toBe(false);
    }
    for (const queue of ['fleet-billing-fanout', 'member-invoices']) {
      expect(grantsKey(user('ocpp'), `bull:${queue}:wait`, 'r'), queue).toBe(false);
    }

    for (const name of ['api', 'ocpp', 'ocpi', 'css']) {
      expect(grantsKey(user(name), 'bull:cron-jobs:wait', 'r'), name).toBe(false);
    }
    for (const name of ['api', 'ocpi', 'css']) {
      expect(grantsKey(user(name), `${registryPrefix as string}CS-1`, 'r'), name).toBe(false);
    }
    expect(user('css').keys).toEqual([]);
    expect(user('css').readKeys).toEqual([]);
  });

  it('TC-AI-C-13 grants the api user the AI keys it writes, and the usage ledger needs none', () => {
    // The only AI Redis keys are the per-minute counters (ai:rl:*). Budget sums are
    // in-process caches and threshold notices are database claim rows, so the
    // usage ledger adds no key and no wider ~ai:* grant is needed.
    const ledger = readFileSync(join(ROOT, 'packages/database/src/lib/ai-usage.ts'), 'utf8');
    expect(ledger).not.toMatch(/createRedisClient|ioredis/);
    expect(grantsKey(user('api'), 'ai:rl:user:usr_1:1', 'rw')).toBe(true);
    expect(grantsKey(user('worker'), 'ai:rl:user:usr_1:1', 'r')).toBe(false);
  });

  it('creates every Redis client through the TLS-aware factory', () => {
    // new Redis(...) outside redis-client.ts would skip REDIS_TLS_CA_PEM. The
    // response cache keeps its own client and spreads redisTlsOptions into it.
    const allowed = new Set(['lib/src/redis-client.ts', 'api/src/plugins/response-cache.ts']);
    for (const pkg of readdirSync(join(ROOT, 'packages'))) {
      const src = join(ROOT, 'packages', pkg, 'src');
      if (!statSync(join(ROOT, 'packages', pkg)).isDirectory()) continue;
      let files: string[] = [];
      try {
        files = sourceFiles(src);
      } catch {
        continue;
      }
      for (const file of files) {
        const rel = file.slice(join(ROOT, 'packages').length + 1);
        if (allowed.has(rel)) continue;
        expect(readFileSync(file, 'utf8'), rel).not.toMatch(/new Redis\(/);
      }
    }
    expect(readFileSync(join(ROOT, 'packages/api/src/plugins/response-cache.ts'), 'utf8')).toMatch(
      /\.\.\.redisTlsOptions\(/,
    );
  });

  it('keeps ocpp_commands away from the simulator', () => {
    expect(user('css').channels).not.toContain('ocpp_commands');
  });
});
