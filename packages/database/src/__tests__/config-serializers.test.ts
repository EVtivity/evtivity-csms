// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterAll, describe, expect, it } from 'vitest';
import { client } from '../config.js';

afterAll(async () => {
  await client.end({ timeout: 1 });
});

describe('client.options.serializers', () => {
  const serializers = client.options.serializers as Record<string, (x: unknown) => string>;

  describe('json (OID 114) and jsonb (OID 3802)', () => {
    it.each(['114', '3802'])('JSON-stringifies an Object for OID %s', (oid) => {
      const serializer = serializers[oid];
      expect(serializer).toBeTypeOf('function');
      expect(serializer({ evseId: 1, action: 'Heartbeat' })).toBe(
        '{"evseId":1,"action":"Heartbeat"}',
      );
    });

    it.each(['114', '3802'])('handles nested arrays and objects for OID %s', (oid) => {
      const serializer = serializers[oid];
      const payload = {
        meterValue: [{ timestamp: '2026-06-04T01:50:00Z', sampledValue: [{ value: 1 }] }],
      };
      expect(serializer(payload)).toBe(JSON.stringify(payload));
    });

    it.each(['114', '3802'])('returns empty-object JSON for OID %s', (oid) => {
      const serializer = serializers[oid];
      expect(serializer({})).toBe('{}');
    });

    it.each(['114', '3802'])('passes pre-stringified JSON through unchanged for OID %s', (oid) => {
      const serializer = serializers[oid];
      expect(serializer('{"evseId":1}')).toBe('{"evseId":1}');
    });

    it.each(['114', '3802'])(
      'does NOT throw on Object input (regression for ERR_INVALID_ARG_TYPE) for OID %s',
      (oid) => {
        const serializer = serializers[oid];
        expect(() => serializer({ a: 1, b: 'two' })).not.toThrow();
      },
    );
  });

  describe('date OIDs (1184/1082/1083/1114/1182/1185/1115/1231)', () => {
    const dateOids = ['1184', '1082', '1083', '1114', '1182', '1185', '1115', '1231'];

    it.each(dateOids)('serializes a Date instance to ISO-8601 for OID %s', (oid) => {
      const serializer = serializers[oid];
      expect(serializer).toBeTypeOf('function');
      const fixed = new Date('2026-06-04T01:50:00.000Z');
      expect(serializer(fixed)).toBe('2026-06-04T01:50:00.000Z');
    });

    it.each(dateOids)('passes an already-ISO string through unchanged for OID %s', (oid) => {
      const serializer = serializers[oid];
      expect(serializer('2026-06-04T01:50:00.000Z')).toBe('2026-06-04T01:50:00.000Z');
    });
  });
});
