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

describe('OCPP schema routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/ocpp/schemas/:action returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ocpp/schemas/Reset',
    });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/ocpp/schemas/:action returns 404 for unknown action', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ocpp/schemas/UnknownAction',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('UNKNOWN_ACTION');
  });

  it('GET /v1/ocpp/schemas/:action returns JSON schema for known 2.1 action', async () => {
    const schemaJson = JSON.stringify({ type: 'object', properties: { type: { type: 'string' } } });
    mockReadFile.mockResolvedValueOnce(schemaJson);

    const response = await app.inject({
      method: 'GET',
      url: '/ocpp/schemas/Reset',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['cache-control']).toBe('public, max-age=86400');
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('type', 'object');
  });

  it('GET /v1/ocpp/schemas/:action returns schema for 1.6 action', async () => {
    const schemaJson = JSON.stringify({ type: 'object', properties: {} });
    mockReadFile.mockResolvedValueOnce(schemaJson);

    const response = await app.inject({
      method: 'GET',
      url: '/ocpp/schemas/Reset?version=ocpp1.6',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('GET /v1/ocpp/schemas/:action returns 404 when schema file not found', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

    const response = await app.inject({
      method: 'GET',
      url: '/ocpp/schemas/GetBaseReport',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('SCHEMA_NOT_FOUND');
  });

  it('GET /v1/ocpp/schemas/:action returns 404 for unknown 1.6 action', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ocpp/schemas/GetBaseReport?version=ocpp1.6',
      headers: { authorization: `Bearer ${token}` },
    });
    // GetBaseReport is not in ActionRegistry16 mock
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('UNKNOWN_ACTION');
  });

  it('route registration works without error', async () => {
    const freshApp = Fastify();
    await registerAuth(freshApp);
    ocppSchemaRoutes(freshApp);
    await freshApp.ready();
    await freshApp.close();
  });

  it('GET /v1/ocpp/schemas/:action sets cache headers', async () => {
    const schemaJson = JSON.stringify({ type: 'object' });
    mockReadFile.mockResolvedValueOnce(schemaJson);

    const response = await app.inject({
      method: 'GET',
      url: '/ocpp/schemas/ChangeAvailability',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=86400');
  });
});

describe('OCPP command schema routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /ocpp/commands/v21/:action/schema returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ocpp/commands/v21/Reset/schema',
    });
    expect(response.statusCode).toBe(401);
  });

  it('GET /ocpp/commands/v21/:action/schema returns processed schema for known action', async () => {
    const schemaJson = JSON.stringify({
      type: 'object',
      definitions: {
        ResetEnumType: {
          type: 'string',
          enum: ['Immediate', 'OnIdle'],
          description: 'Reset type',
        },
      },
      properties: {
        type: { $ref: '#/definitions/ResetEnumType' },
        evseId: { type: 'integer', description: 'EVSE ID' },
      },
      required: ['type'],
    });
    mockReadFile.mockResolvedValueOnce(schemaJson);

    const response = await app.inject({
      method: 'GET',
      url: '/ocpp/commands/v21/Reset/schema',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.action).toBe('Reset');
    expect(body.version).toBe('ocpp2.1');
    expect(body.fields).toBeInstanceOf(Array);
    expect(body.fields.length).toBe(2);
    expect(body.fields[0].name).toBe('type');
    expect(body.fields[0].type).toBe('enum');
    expect(body.fields[0].required).toBe(true);
    expect(body.fields[0].values).toEqual(['Immediate', 'OnIdle']);
    expect(body.fields[1].name).toBe('evseId');
    expect(body.fields[1].type).toBe('integer');
    expect(body.fields[1].required).toBe(false);
    expect(body.example).toHaveProperty('type', 'Immediate');
    expect(body.example).not.toHaveProperty('evseId');
    expect(response.headers['cache-control']).toBe('public, max-age=86400');
  });

  it('GET /ocpp/commands/v21/:action/schema returns 404 for unknown action', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ocpp/commands/v21/UnknownAction/schema',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('UNKNOWN_ACTION');
  });

  it('GET /ocpp/commands/v21/:action/schema returns 404 when schema file missing', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

    const response = await app.inject({
      method: 'GET',
      url: '/ocpp/commands/v21/GetBaseReport/schema',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('SCHEMA_NOT_FOUND');
  });

  it('GET /ocpp/commands/v16/:action/schema returns processed schema for 1.6 action', async () => {
    const schemaJson = JSON.stringify({
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['Hard', 'Soft'],
        },
      },
      required: ['type'],
    });
    mockReadFile.mockResolvedValueOnce(schemaJson);

    const response = await app.inject({
      method: 'GET',
      url: '/ocpp/commands/v16/Reset/schema',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.action).toBe('Reset');
    expect(body.version).toBe('ocpp1.6');
    expect(body.fields[0].type).toBe('enum');
    expect(body.fields[0].values).toEqual(['Hard', 'Soft']);
    expect(body.example).toHaveProperty('type', 'Hard');
  });

  it('GET /ocpp/commands/v16/:action/schema returns 404 for unknown 1.6 action', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ocpp/commands/v16/GetBaseReport/schema',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('UNKNOWN_ACTION');
  });

  it('GET /ocpp/commands/v21/:action/schema handles object fields', async () => {
    const schemaJson = JSON.stringify({
      type: 'object',
      definitions: {
        EVSEType: {
          type: 'object',
          description: 'EVSE',
          properties: {
            id: { type: 'integer', description: 'EVSE ID' },
            connectorId: { type: 'integer', description: 'Connector ID' },
          },
          required: ['id'],
        },
        OperationalStatusEnumType: {
          type: 'string',
          enum: ['Inoperative', 'Operative'],
          description: 'Operational status',
        },
      },
      properties: {
        evse: { $ref: '#/definitions/EVSEType' },
        operationalStatus: { $ref: '#/definitions/OperationalStatusEnumType' },
      },
      required: ['operationalStatus'],
    });
    mockReadFile.mockResolvedValueOnce(schemaJson);

    const response = await app.inject({
      method: 'GET',
      url: '/ocpp/commands/v21/ChangeAvailability/schema',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    const evseField = body.fields.find((f: { name: string }) => f.name === 'evse');
    expect(evseField.type).toBe('object');
    expect(evseField.fields).toBeInstanceOf(Array);
    expect(evseField.fields.length).toBeGreaterThan(0);
    expect(body.example).toHaveProperty('operationalStatus', 'Inoperative');
    expect(body.example).not.toHaveProperty('evse');
  });
});
