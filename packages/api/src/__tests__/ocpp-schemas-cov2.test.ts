// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// Mock node:fs/promises for file reading - use vi.hoisted to avoid hoisting issues
const { mockReadFile } = vi.hoisted(() => {
  return { mockReadFile: vi.fn() };
});

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
  invalidatePermissionCache: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

// Mock the @evtivity/ocpp module for ActionRegistry
vi.mock('@evtivity/ocpp', () => ({
  ActionRegistry: {
    Reset: {
      validateRequest: vi.fn().mockReturnValue(true),
    },
    GetBaseReport: {
      validateRequest: vi.fn().mockReturnValue(true),
    },
    ChangeAvailability: {
      validateRequest: vi.fn().mockReturnValue(true),
    },
    SetVariables: {
      validateRequest: vi.fn().mockReturnValue(true),
    },
  },
  ActionRegistry16: {
    Reset: {
      validateRequest: vi.fn().mockReturnValue(true),
    },
    ChangeConfiguration: {
      validateRequest: vi.fn().mockReturnValue(true),
    },
  },
}));

import { registerAuth } from '../plugins/auth.js';
import { ocppSchemaRoutes } from '../routes/ocpp-schemas.js';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  ocppSchemaRoutes(app);
  await app.ready();
  return app;
}

describe('OCPP command schema processing (all field types)', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  it('maps every JSON schema type to a field and builds defaults for required ones', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
    const schemaJson = JSON.stringify({
      type: 'object',
      definitions: {
        ChargingProfileType: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            note: { type: 'string' },
          },
          required: ['id'],
        },
        IdTokenType: {
          type: 'object',
          description: 'Token\r\n   with   spaces',
          properties: {
            idToken: { type: 'string', maxLength: 36 },
            flag: { type: 'boolean' },
          },
          required: ['idToken', 'flag'],
        },
        PlainType: { type: 'string', maxLength: 8, description: 'plain' },
      },
      properties: {
        customData: { type: 'object' },
        missingRef: { $ref: '#/definitions/DoesNotExist' },
        profiles: {
          type: 'array',
          description: 'list',
          items: { $ref: '#/definitions/ChargingProfileType' },
        },
        tags: { type: 'array', items: { type: 'string' } },
        refArrayNoObject: { type: 'array', items: { $ref: '#/definitions/PlainType' } },
        startTime: { type: 'string', format: 'date-time', description: 'Start' },
        enabled: { type: 'boolean', description: 'Enabled' },
        limit: { type: 'number', maximum: 10 },
        count: { type: 'integer' },
        token: { $ref: '#/definitions/IdTokenType' },
        plain: { $ref: '#/definitions/PlainType' },
        name: { type: 'string' },
      },
      required: [
        'customData',
        'missingRef',
        'profiles',
        'startTime',
        'enabled',
        'limit',
        'count',
        'token',
        'plain',
        'name',
      ],
    });
    mockReadFile.mockResolvedValueOnce(schemaJson);

    const response = await app.inject({
      method: 'GET',
      url: '/ocpp/commands/v21/SetVariables/schema',
      headers: { authorization: `Bearer ${token}` },
    });
    vi.useRealTimers();
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      fields: Array<Record<string, unknown>>;
      example: Record<string, unknown>;
    };
    const byName = Object.fromEntries(body.fields.map((f) => [f['name'], f]));

    expect(byName['customData']).toBeUndefined();
    expect(byName['missingRef']).toEqual({
      name: 'missingRef',
      type: 'string',
      required: true,
      description: '',
    });
    expect(byName['profiles']).toMatchObject({ type: 'array', description: 'list' });
    expect(byName['profiles']?.['fields']).toEqual([
      { name: 'id', type: 'integer', required: true, description: '' },
      { name: 'note', type: 'string', required: false, description: '' },
    ]);
    expect(byName['tags']).toMatchObject({ type: 'array', required: false });
    expect(byName['tags']?.['fields']).toBeUndefined();
    expect(byName['refArrayNoObject']?.['fields']).toBeUndefined();
    expect(byName['startTime']).toEqual({
      name: 'startTime',
      type: 'datetime',
      required: true,
      description: 'Start',
    });
    expect(byName['enabled']).toMatchObject({ type: 'boolean', description: 'Enabled' });
    expect(byName['limit']).toMatchObject({ type: 'number', maximum: 10 });
    expect(byName['limit']).not.toHaveProperty('minimum');
    expect(byName['token']).toMatchObject({ type: 'object', description: 'Token with spaces' });
    expect(byName['plain']).toEqual({
      name: 'plain',
      type: 'string',
      required: true,
      description: 'plain',
      maxLength: 8,
    });

    expect(body.example).toEqual({
      missingRef: '',
      profiles: [],
      startTime: '2026-01-02T03:04:05.000Z',
      enabled: false,
      limit: 0,
      count: 0,
      token: { idToken: '', flag: false },
      plain: '',
      name: '',
    });
  });

  it('builds an empty object default for a required object with no fields', async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        definitions: { EmptyType: { type: 'object', properties: {} } },
        properties: { empty: { $ref: '#/definitions/EmptyType' } },
        required: ['empty'],
      }),
    );
    const response = await app.inject({
      method: 'GET',
      url: '/ocpp/commands/v16/ChangeConfiguration/schema',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { example: Record<string, unknown> };
    expect(body.example).toEqual({ empty: {} });
  });

  it('serves a processed schema from cache without reading the file again', async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({ properties: { type: { type: 'string', enum: ['Hard'] } } }),
    );
    const first = await app.inject({
      method: 'GET',
      url: '/ocpp/commands/v16/Reset/schema',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(200);
    mockReadFile.mockReset();
    mockReadFile.mockRejectedValue(new Error('should not be read'));

    const second = await app.inject({
      method: 'GET',
      url: '/ocpp/commands/v16/Reset/schema',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers['cache-control']).toBe('public, max-age=86400');
    expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));
    expect(mockReadFile).not.toHaveBeenCalled();
    mockReadFile.mockReset();
  });
});
