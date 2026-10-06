// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { PubSubClient } from '@evtivity/lib';
import { encryptString } from '@evtivity/lib';

let dbResults: unknown[][] = [];
const whereArgs: unknown[] = [];
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['where'] = vi.fn((arg: unknown) => {
    whereArgs.push(arg);
    return chain;
  });
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(dbResults.shift() ?? []).then(resolve);
  return chain;
}

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: { select: vi.fn(() => makeChain()) },
}));

const { parseRoutingHeaders, buildRoutingHeaders } = await import('../lib/ocpi-headers.js');
const { getOutboundToken } = await import('../lib/outbound-token.js');
const pubsubModule = await import('../lib/pubsub.js');

const KEY = 'test-encryption-key-32chars!!!!!';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function req(headers: Record<string, string>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

describe('parseRoutingHeaders', () => {
  it('reads request, correlation and routing headers', () => {
    const result = parseRoutingHeaders(
      req({
        'x-request-id': 'req-1',
        'x-correlation-id': 'corr-1',
        'ocpi-from-country-code': 'NL',
        'ocpi-from-party-id': 'ABC',
        'ocpi-to-country-code': 'US',
        'ocpi-to-party-id': 'EVT',
      }),
    );
    expect(result).toEqual({
      requestId: 'req-1',
      correlationId: 'corr-1',
      fromCountryCode: 'NL',
      fromPartyId: 'ABC',
      toCountryCode: 'US',
      toPartyId: 'EVT',
    });
  });

  it('generates distinct UUIDs and omits absent routing headers', () => {
    const result = parseRoutingHeaders(req({}));
    expect(result.requestId).toMatch(UUID_RE);
    expect(result.correlationId).toMatch(UUID_RE);
    expect(result.requestId).not.toBe(result.correlationId);
    expect(Object.keys(result).sort()).toEqual(['correlationId', 'requestId']);
  });
});

describe('buildRoutingHeaders', () => {
  it('builds OCPI routing headers with the given correlation id', () => {
    const headers = buildRoutingHeaders('US', 'EVT', 'NL', 'ABC', 'corr-9');
    expect(headers['X-Correlation-ID']).toBe('corr-9');
    expect(headers['X-Request-ID']).toMatch(UUID_RE);
    expect(headers['OCPI-from-country-code']).toBe('US');
    expect(headers['OCPI-from-party-id']).toBe('EVT');
    expect(headers['OCPI-to-country-code']).toBe('NL');
    expect(headers['OCPI-to-party-id']).toBe('ABC');
  });

  it('generates a correlation id when none is given', () => {
    const headers = buildRoutingHeaders('US', 'EVT', 'NL', 'ABC');
    expect(headers['X-Correlation-ID']).toMatch(UUID_RE);
    expect(headers['X-Correlation-ID']).not.toBe(headers['X-Request-ID']);
  });
});

describe('getOutboundToken', () => {
  beforeEach(() => {
    dbResults = [];
    whereArgs.length = 0;
  });

  it('decrypts the stored outbound token', async () => {
    dbResults = [[{ outboundTokenEnc: encryptString('partner-token-B', KEY) }]];
    await expect(getOutboundToken('opr_000000000001')).resolves.toBe('partner-token-B');
    expect(whereArgs).toHaveLength(1);
  });

  it('returns null when the partner has no received token', async () => {
    dbResults = [[]];
    await expect(getOutboundToken('opr_000000000001')).resolves.toBeNull();
  });

  it('returns null when the row has no ciphertext', async () => {
    dbResults = [[{ outboundTokenEnc: null }]];
    await expect(getOutboundToken('opr_000000000001')).resolves.toBeNull();
  });

  it('returns null instead of throwing when the ciphertext cannot be decrypted', async () => {
    dbResults = [[{ outboundTokenEnc: encryptString('partner-token-B', 'another-key-entirely') }]];
    await expect(getOutboundToken('opr_000000000001')).resolves.toBeNull();
  });
});

describe('pubsub', () => {
  it('returns a no-op client before one is set', async () => {
    const client = pubsubModule.getPubSub();
    await expect(client.publish('csms_events', '{}')).resolves.toBeUndefined();
    // Notifications do not throw without a client.
    expect(() => {
      pubsubModule.notifyRoamingSessionChanged();
      pubsubModule.notifyRoamingCdrChanged();
    }).not.toThrow();
  });

  it('publishes roaming change events on csms_events through the set client', async () => {
    const publish = vi.fn((_channel: string, _payload: string) => Promise.resolve());
    const client = { publish, subscribe: vi.fn(), close: vi.fn() } as unknown as PubSubClient;
    pubsubModule.setPubSub(client);
    expect(pubsubModule.getPubSub()).toBe(client);

    pubsubModule.notifyRoamingSessionChanged();
    pubsubModule.notifyRoamingCdrChanged();

    expect(publish.mock.calls).toEqual([
      ['csms_events', JSON.stringify({ eventType: 'roaming.session.changed' })],
      ['csms_events', JSON.stringify({ eventType: 'roaming.cdr.changed' })],
    ]);
  });

  it('swallows a rejected publish', async () => {
    let rejected = 0;
    const publish = vi.fn(() => {
      rejected++;
      return Promise.reject(new Error('redis down'));
    });
    pubsubModule.setPubSub({ publish } as unknown as PubSubClient);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      pubsubModule.notifyRoamingSessionChanged();
      pubsubModule.notifyRoamingCdrChanged();
      // Let the rejected promises and their catch handlers settle.
      await new Promise((resolve) => setImmediate(resolve));
      expect(rejected).toBe(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
