// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import { currentAuditViaAi } from '@evtivity/database';
import {
  buildToolRequest,
  createToolset,
  currentAiToolCall,
  isAiToolRequest,
  prepareToolCall,
  registerAiToolCallContext,
  runToolCall,
} from '../services/ai/tools/execute.js';
import type { ToolsetEntry } from '../services/ai/tools/execute.js';
import type { AiCatalogTool } from '../services/ai/tools/catalog-types.js';
import { dropStrictNulls, toStrictSchema } from '../services/ai/tools/schema.js';
import { supportToolset } from '../services/ai/surfaces/toolsets.js';

const validation = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '^sta_[a-z0-9]{12}$' },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    siteId: { type: 'string', nullable: true },
    note: { type: 'string' },
  },
  required: ['id'],
  additionalProperties: false,
};

const TOOL: AiCatalogTool = {
  name: 'update_station',
  operationId: 'updateStation',
  description: 'Update a station',
  category: 'Stations',
  method: 'PATCH',
  pathTemplate: '/v1/stations/{id}',
  pathParams: ['id'],
  queryParams: ['limit'],
  bodyParams: ['siteId', 'note'],
  parameters: toStrictSchema(validation) ?? validation,
  strict: true,
  validation,
  responseFields: [],
};

function entry(overrides: Partial<ToolsetEntry> = {}): ToolsetEntry {
  return {
    tool: TOOL,
    definition: {
      name: TOOL.name,
      description: TOOL.description,
      parameters: TOOL.parameters,
      strict: true,
    },
    fixedArgs: {},
    allowedValues: {},
    omitted: ['password'],
    ...overrides,
  };
}

describe('preparing a tool call', () => {
  const toolset = createToolset([entry()]);

  it('refuses a tool the turn does not offer', () => {
    const p = prepareToolCall(toolset, 'list_settings', {});
    expect(p.ok).toBe(false);
  });

  it('TC-AI-T-08 refuses arguments that do not match the operation schema', () => {
    for (const args of [
      {},
      { id: 'not-an-id' },
      { id: 'sta_000000000001', limit: 1000 },
      { id: 'sta_000000000001', extra: 1 },
    ]) {
      const p = prepareToolCall(toolset, 'update_station', args);
      expect(p.ok, JSON.stringify(args)).toBe(false);
    }
  });

  it('refuses an omitted argument (a station password)', () => {
    const p = prepareToolCall(toolset, 'update_station', {
      id: 'sta_000000000001',
      password: 'x'.repeat(20),
    });
    expect(p).toMatchObject({ ok: false });
  });

  it('drops the nulls of strict mode but keeps a null the operation accepts', () => {
    const p = prepareToolCall(toolset, 'update_station', {
      id: 'sta_000000000001',
      limit: null,
      note: null,
      siteId: null,
    });
    expect(p).toMatchObject({ ok: true, args: { id: 'sta_000000000001', siteId: null } });
    expect(dropStrictNulls({ a: null }, { properties: { a: { type: 'string' } } })).toEqual({});
  });

  it.each(['.', '..'])('refuses the dot segment %s as a path value', (id) => {
    const loose = { type: 'object', properties: { id: { type: 'string' } } };
    const tool: AiCatalogTool = { ...TOOL, validation: loose, parameters: loose };
    const looseSet = createToolset([entry({ tool })]);
    expect(prepareToolCall(looseSet, 'update_station', { id })).toMatchObject({
      ok: false,
      refusal: { reason: 'invalid_arguments', modelText: 'Invalid path value for id' },
    });
    expect(prepareToolCall(looseSet, 'update_station', { id: '..x' }).ok).toBe(true);
  });

  it('TC-AI-T-11 a pinned argument overrides the one the model sent', () => {
    const pinned = createToolset([entry({ fixedArgs: { id: 'sta_000000000009' } })]);
    const p = prepareToolCall(pinned, 'update_station', { id: 'sta_000000000001' });
    expect(p).toMatchObject({ ok: true, args: { id: 'sta_000000000009' } });
  });

  it('TC-AI-T-11 a constrained argument must be one of the case values', () => {
    const constrained = createToolset([entry({ allowedValues: { id: ['sta_000000000002'] } })]);
    expect(prepareToolCall(constrained, 'update_station', { id: 'sta_000000000001' }).ok).toBe(
      false,
    );
    expect(prepareToolCall(constrained, 'update_station', { id: 'sta_000000000002' }).ok).toBe(
      true,
    );
  });

  it('TC-AI-I-02 the support toolset hides the case ids from the model', () => {
    const ctx = {
      caseId: 'cas_000000000001',
      stationId: 'sta_000000000001',
      driverId: 'drv_000000000001',
      sessionIds: ['ses_000000000001'],
    };
    const ts = supportToolset(ctx);
    const getCase = ts.byName.get('get_support_case');
    expect(getCase?.fixedArgs).toEqual({ id: 'cas_000000000001' });
    expect(
      Object.keys((getCase?.definition.parameters['properties'] as object | undefined) ?? {}),
    ).not.toContain('id');
    const p = prepareToolCall(ts, 'get_support_case', { id: 'cas_00000000other' });
    expect(p).toMatchObject({ ok: true, args: { id: 'cas_000000000001' } });
    const session = ts.byName.get('get_session');
    expect(
      (session?.definition.parameters['properties'] as Record<string, { enum?: string[] }>)['id']
        ?.enum,
    ).toEqual(['ses_000000000001']);
    expect(prepareToolCall(ts, 'get_session', { id: 'ses_00000000othr' }).ok).toBe(false);
  });
});

describe('building the request', () => {
  it('puts path, query and body arguments where they belong', () => {
    const req = buildToolRequest(TOOL, { id: 'sta/1', limit: 5, note: 'n', ignored: 1 });
    expect(req).toEqual({
      method: 'PATCH',
      url: '/v1/stations/sta%2F1',
      query: { limit: '5' },
      body: { note: 'n' },
    });
  });

  it('turns arrays into repeated query values', () => {
    const get: AiCatalogTool = { ...TOOL, method: 'GET', queryParams: ['status'], bodyParams: [] };
    expect(buildToolRequest(get, { id: 'x', status: ['a', 'b'] }).query).toEqual({
      status: ['a', 'b'],
    });
  });
});

describe('running a tool call', () => {
  let app: FastifyInstance;
  const seen: unknown[] = [];

  beforeAll(async () => {
    app = Fastify({ logger: false });
    registerAiToolCallContext(app);
    app.patch('/v1/stations/:id', async (request) => {
      seen.push({
        ai: isAiToolRequest(),
        ctx: currentAiToolCall(),
        viaAi: currentAuditViaAi(),
        auth: request.headers.authorization,
      });
      return {
        id: (request.params as { id: string }).id,
        apiKeyEnc: 'cipher',
        note: 'Bearer abcdefghijklmnop',
      };
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs as the user in the AI context, and the result is redacted and framed', async () => {
    const outcome = await runToolCall(
      app,
      { entry: entry(), args: { id: 'sta_000000000001', note: 'x' } },
      'Bearer user-token',
      { conversationId: 'aic_1', toolCallRowId: 'atc_1', surface: 'chatbot', userId: 'usr_1' },
    );
    expect(seen[0]).toEqual({
      ai: true,
      ctx: { conversationId: 'aic_1', toolCallRowId: 'atc_1', surface: 'chatbot', userId: 'usr_1' },
      viaAi: { conversationId: 'aic_1', toolCallId: 'atc_1' },
      auth: 'Bearer user-token',
    });
    expect(isAiToolRequest()).toBe(false);
    expect(outcome.status).toBe('ok');
    expect(outcome.content).toContain('<untrusted source="tool_result" id="update_station">');
    expect(outcome.content).not.toContain('cipher');
    expect(outcome.content).not.toContain('abcdefghijklmnop');
    expect(outcome.redactionCounts).toEqual({ keys: 1, values: 1, pii: 0 });
    expect(outcome.summary).toBe('PATCH /v1/stations/sta_000000000001 200');
  });
});
