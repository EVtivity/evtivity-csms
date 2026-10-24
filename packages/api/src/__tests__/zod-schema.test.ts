// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, afterAll } from 'vitest';
import Fastify from 'fastify';
import { z } from 'zod';
import { parseZodRequest, rejectUnknownBodyKeys, zodSchema } from '../lib/zod-schema.js';

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

  it('refuses unnamed keys of a plain object and allows them on a loose one', () => {
    expect(zodSchema(z.object({ a: z.string() }))).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    });
    expect(zodSchema(z.object({ a: z.string() }).loose())['additionalProperties']).toBe(true);
  });

  it('publishes a string format as the format alone, without the Zod pattern', () => {
    const schema = zodSchema(
      z.object({
        email: z.email(),
        id: z.guid(),
        url: z.url(),
        at: z.iso.datetime(),
        code: z.string().regex(/^[A-Z]{2}$/),
      }),
    );

    expect(schema['properties']).toEqual({
      email: { type: 'string', format: 'email' },
      id: { type: 'string', format: 'uuid' },
      url: { type: 'string', format: 'uri' },
      at: { type: 'string', format: 'date-time' },
      code: { type: 'string', pattern: '^[A-Z]{2}$' },
    });
  });

  it('keeps the format next to a custom pattern and drops formats Ajv does not know', () => {
    const schema = zodSchema(
      z.object({ email: z.email().regex(/@example\.com$/), key: z.string().startsWith('k_') }),
    );

    expect(schema['properties']).toEqual({
      email: { type: 'string', format: 'email', pattern: '@example\\.com$' },
      key: { type: 'string', pattern: '^k_.*' },
    });
  });

  it('publishes an integer without implicit bounds and a date as a date-time string', () => {
    const schema = zodSchema(z.object({ n: z.number().int().min(1), d: z.date() }));

    expect(schema['properties']).toEqual({
      n: { type: 'integer', minimum: 1 },
      d: { type: 'string', format: 'date-time' },
    });
  });

  it('is the request side: a field with a default is optional and carries it', () => {
    const schema = zodSchema(z.object({ page: z.coerce.number().int().default(1) }));

    expect(schema).toEqual({
      type: 'object',
      properties: { page: { type: 'integer', default: 1 } },
      additionalProperties: false,
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
      // Report what Ajv let through rather than echoing the body back.
      async (request) => ({ kindIsNull: (request.body as { kind?: unknown }).kind === null }),
    );

    afterAll(async () => {
      await app.close();
    });

    it('accepts null for a nullable enum', async () => {
      const res = await app.inject({ method: 'PATCH', url: '/things', payload: { kind: null } });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ kindIsNull: true });
    });

    it('still rejects values outside the enum', async () => {
      const res = await app.inject({ method: 'PATCH', url: '/things', payload: { kind: 'c' } });

      expect(res.statusCode).toBe(400);
    });
  });
});

describe('parseZodRequest', () => {
  const phases = z.object({
    phases: z
      .number()
      .int()
      .refine((v) => [1, 3].includes(v), { message: 'Phases must be 1 or 3' }),
  });

  it('shows why it exists: the JSON Schema for Ajv has no trace of the refine', () => {
    expect(zodSchema(phases)['properties']).toEqual({ phases: { type: 'integer' } });
  });

  it('throws a 400 VALIDATION_ERROR with the refine message', () => {
    expect(() => {
      parseZodRequest(phases, { phases: 2 });
    }).toThrow(
      expect.objectContaining({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Phases must be 1 or 3',
      }),
    );
  });

  it('returns a value that satisfies the refine', () => {
    expect(parseZodRequest(phases, { phases: 3 })).toEqual({ phases: 3 });
  });

  const contact = z.object({
    email: z.email().transform((s) => s.trim().toLowerCase()),
    name: z.string().trim().min(1),
    from: z.coerce.date().optional(),
  });

  it('returns the zod output: transforms, trims and coercions applied', () => {
    expect(
      parseZodRequest(contact, {
        email: 'Op@Example.COM',
        name: '  Main ',
        from: '2026-01-02T03:04:05.000Z',
      }),
    ).toEqual({
      email: 'op@example.com',
      name: 'Main',
      from: new Date('2026-01-02T03:04:05.000Z'),
    });
  });

  describe('in a route', () => {
    const app = Fastify();
    app.post('/panels', { schema: { body: zodSchema(phases) } }, async (request) => {
      return parseZodRequest(phases, request.body);
    });

    afterAll(async () => {
      await app.close();
    });

    app.post('/contacts', { schema: { body: zodSchema(contact) } }, async (request) => {
      const body = parseZodRequest(contact, request.body);
      return { email: body.email, name: body.name, from: body.from?.toISOString() ?? null };
    });

    it('hands the handler the transformed value that Ajv alone leaves unchanged', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/contacts',
        payload: { email: 'Op@Example.COM', name: '  Main ', from: '2026-01-02T03:04:05Z' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        email: 'op@example.com',
        name: 'Main',
        from: '2026-01-02T03:04:05.000Z',
      });
    });

    it('rejects a body that passes Ajv but fails the refine', async () => {
      const res = await app.inject({ method: 'POST', url: '/panels', payload: { phases: 2 } });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Phases must be 1 or 3',
      });
    });
  });
});

describe('rejectUnknownBodyKeys', () => {
  const body = z.object({ name: z.string().optional(), size: z.number().optional() });
  const app = Fastify();
  app.patch(
    '/things',
    {
      preValidation: [rejectUnknownBodyKeys(body, { color: 'use PUT /things/color' })],
      schema: { body: zodSchema(body) },
    },
    async (request) => ({ keys: Object.keys(request.body as object) }),
  );

  afterAll(async () => {
    await app.close();
  });

  it('shows why it exists: without it Ajv drops an unknown key and answers 200', async () => {
    const plain = Fastify();
    plain.patch('/things', { schema: { body: zodSchema(body) } }, async (request) => ({
      keys: Object.keys(request.body as object),
    }));
    const res = await plain.inject({ method: 'PATCH', url: '/things', payload: { colour: 1 } });
    await plain.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ keys: [] });
  });

  it('accepts a body with known keys only', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/things', payload: { name: 'a' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ keys: ['name'] });
  });

  it('refuses an unknown key with 400 VALIDATION_ERROR naming it', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/things',
      payload: { name: 'a', colour: 'red' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Unknown field colour' });
  });

  it('adds the hint of a key that belongs to another route', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/things', payload: { color: 'red' } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      message: 'Unknown field color: use PUT /things/color',
    });
  });
});
