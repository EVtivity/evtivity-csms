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
    expect(channelsUsedBy('worker').has('station_watch_available')).toBe(true);
    expect(channelsUsedBy('api').has('css_commands')).toBe(true);
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
    expect(watchKey).toBeDefined();
    expect(registryPrefix).toBeDefined();
    expect(noncePrefix).toBeDefined();

    // BullMQ (prefix "bull"), the maintenance fan-out and station render locks, the watch key.
    expect(grantsKey(user('worker'), 'bull:cron-jobs:wait', 'rw')).toBe(true);
    expect(grantsKey(user('worker'), 'mfl:site-1', 'rw')).toBe(true);
    expect(grantsKey(user('worker'), 'sml:sta_1', 'rw')).toBe(true);
    expect(grantsKey(user('worker'), watchKey as string, 'rw')).toBe(true);
    // The connection registry belongs to ocpp; the worker's offline sweep reads it.
    expect(grantsKey(user('ocpp'), `${registryPrefix as string}CS-1`, 'rw')).toBe(true);
    expect(grantsKey(user('worker'), `${registryPrefix as string}CS-1`, 'r')).toBe(true);
    expect(grantsKey(user('worker'), `${registryPrefix as string}CS-1`, 'rw')).toBe(false);
    // Response cache and attestation nonces; the watch key read-only.
    expect(grantsKey(user('api'), 'rc:ver:stations', 'rw')).toBe(true);
    expect(grantsKey(user('api'), `${noncePrefix as string}abc`, 'rw')).toBe(true);
    expect(grantsKey(user('api'), watchKey as string, 'r')).toBe(true);
    expect(grantsKey(user('api'), watchKey as string, 'rw')).toBe(false);
    // OCPI pull lock and its own BullMQ queue (ocpi-cdrs), no other queue.
    expect(grantsKey(user('ocpi'), 'opl:partner-1:locations', 'rw')).toBe(true);
    expect(grantsKey(user('ocpi'), 'bull:ocpi-cdrs:wait', 'rw')).toBe(true);

    for (const name of ['api', 'ocpp', 'ocpi', 'css']) {
      expect(grantsKey(user(name), 'bull:cron-jobs:wait', 'r'), name).toBe(false);
    }
    for (const name of ['api', 'ocpi', 'css']) {
      expect(grantsKey(user(name), `${registryPrefix as string}CS-1`, 'r'), name).toBe(false);
    }
    expect(user('css').keys).toEqual([]);
    expect(user('css').readKeys).toEqual([]);
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
