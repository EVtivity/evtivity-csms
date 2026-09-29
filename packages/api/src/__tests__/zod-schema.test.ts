// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, afterAll } from 'vitest';
import Fastify from 'fastify';
import { z } from 'zod';
import { zodSchema } from '../lib/zod-schema.js';

describe('zodSchema', () => {
  it('adds null to the enum of a nullable enum', () => {
    const schema = zodSchema(z.object({ kind: z.enum(['a', 'b']).nullable().optional() }));

    expect(schema['properties']).toEqual({
      kind: { type: 'string', enum: ['a', 'b', null], nullable: true },
    });
  });

  it('leaves non-nullable enums unchanged', () => {
    const schema = zodSchema(z.object({ kind: z.enum(['a', 'b']) }));

    expect(schema['properties']).toEqual({ kind: { type: 'string', enum: ['a', 'b'] } });
  });

  it('handles nullable enums nested in arrays and objects', () => {
    const schema = zodSchema(
      z.object({ items: z.array(z.object({ kind: z.enum(['a']).nullable() })) }),
    );

    const items = (schema['properties'] as Record<string, Record<string, unknown>>)['items'];
    const item = items?.['items'] as Record<string, Record<string, unknown>>;
    expect(item['properties']?.['kind']).toEqual({
      type: 'string',
      enum: ['a', null],
      nullable: true,
    });
  });

  describe('request validation', () => {
    const app = Fastify();
    app.patch(
      '/things',
      {
        schema: {
          body: zodSchema(z.object({ kind: z.enum(['a', 'b']).nullable().optional() })),
        },
      },
      async (request) => request.body,
    );

    afterAll(async () => {
      await app.close();
    });

    it('accepts null for a nullable enum', async () => {
      const res = await app.inject({ method: 'PATCH', url: '/things', payload: { kind: null } });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ kind: null });
    });

    it('still rejects values outside the enum', async () => {
      const res = await app.inject({ method: 'PATCH', url: '/things', payload: { kind: 'c' } });

      expect(res.statusCode).toBe(400);
    });
  });
});
