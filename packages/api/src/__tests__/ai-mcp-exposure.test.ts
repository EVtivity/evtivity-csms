// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { AI_MCP_DEFAULT_TOOLSETS } from '@evtivity/lib/ai-proposals';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { AI_OPERATIONS, AI_TOOL_CATALOG } from '../services/ai/tools/catalog.js';
import {
  AI_MCP_EXPOSURE,
  AI_TOOL_POLICY,
  mcpOffers,
  toolPolicy,
} from '../services/ai/tools/policy.js';
import {
  isMcpWriteTool,
  mcpExposureProblems,
  mcpToolList,
  mcpToolset,
  mcpToolsetNames,
  parseMcpToolsets,
  toolsetSlug,
} from '../services/ai/mcp/exposure.js';
import {
  MCP_TOOLS_LIST_TTL_MS,
  createMcpRequestHandler,
  mcpAuthInfo,
} from '../services/ai/mcp/server.js';
import type { McpCaller } from '../services/ai/mcp/tool-call.js';

describe('MCP exposure', () => {
  it('TC-AI-MCP-05: the committed catalog passes the MCP codegen gate', () => {
    expect(
      mcpExposureProblems(AI_OPERATIONS, AI_TOOL_CATALOG, AI_TOOL_POLICY, AI_MCP_EXPOSURE),
    ).toEqual([]);
  });

  it('TC-AI-MCP-05: every read and write entry sets its MCP value; never entries are not listed', () => {
    for (const [operationId, policy] of Object.entries(AI_TOOL_POLICY)) {
      const listed = Object.prototype.hasOwnProperty.call(AI_MCP_EXPOSURE, operationId);
      expect(listed, operationId).toBe(policy.exposure !== 'never');
    }
  });

  it('TC-AI-MCP-05: the gate refuses a missing value, a never entry and a non-OCPP write', () => {
    const station = AI_TOOL_CATALOG.find((t) => t.operationId === 'getStation');
    const update = AI_TOOL_CATALOG.find((t) => t.operationId === 'updateStation');
    expect(station).toBeDefined();
    expect(update).toBeDefined();
    const ops = AI_OPERATIONS.filter((o) =>
      ['getStation', 'updateStation', 'createApiKey'].includes(o.operationId),
    );
    const problems = mcpExposureProblems(
      ops,
      [station, update].filter((t) => t !== undefined),
      AI_TOOL_POLICY,
      { updateStation: true, createApiKey: false, noSuchOperation: true },
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('getStation'),
        expect.stringContaining("createApiKey: a 'never' entry"),
        expect.stringContaining('noSuchOperation'),
        expect.stringContaining('updateStation: an MCP write must be an OCPP command route'),
      ]),
    );
  });

  it('TC-AI-MCP-05: never tools are never offered, writes are OCPP commands only', () => {
    const all = mcpToolset(mcpToolsetNames());
    expect(all.byName.size).toBeGreaterThan(0);
    for (const entry of all.byName.values()) {
      const policy = toolPolicy(entry.tool.operationId);
      expect(policy.exposure).not.toBe('never');
      expect(mcpOffers(entry.tool.operationId)).toBe(true);
      if (policy.exposure === 'write') {
        expect(entry.tool.pathTemplate).toMatch(/^\/v1\/ocpp\/commands\/v(16|21)\//);
      }
    }
    for (const id of ['createApiKey', 'listSettings', 'confirmAiProposal', 'postMcp']) {
      expect(mcpOffers(id), id).toBe(false);
    }
  });

  it('TC-AI-MCP-05: the tool list is in a deterministic name order with untrusted hints', () => {
    const list = mcpToolList(mcpToolset(mcpToolsetNames()));
    const names = list.map((t) => t.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(new Set(names).size).toBe(names.length);
    for (const tool of list) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.annotations.readOnlyHint).toBe(!tool.annotations.destructiveHint);
    }
  });

  it('toolsets: the default core set, slugs, and unknown names', () => {
    expect(toolsetSlug('OCPP 2.1 Commands')).toBe('ocpp-2-1-commands');
    expect(toolsetSlug('AI Proposals')).toBe('ai-proposals');
    expect(parseMcpToolsets(undefined)).toEqual({
      ok: true,
      toolsets: [...AI_MCP_DEFAULT_TOOLSETS],
    });
    expect(parseMcpToolsets(' Stations, ocpp-2-1-commands,stations')).toEqual({
      ok: true,
      toolsets: ['ocpp-2-1-commands', 'stations'],
    });
    const bad = parseMcpToolsets('stations,settings');
    expect(bad).toMatchObject({ ok: false, unknown: ['settings'] });
    // Every default toolset exists and the default list stays in client limits.
    for (const name of AI_MCP_DEFAULT_TOOLSETS) expect(mcpToolsetNames()).toContain(name);
    const size = mcpToolset(AI_MCP_DEFAULT_TOOLSETS).byName.size;
    expect(size).toBeGreaterThan(20);
    expect(size).toBeLessThanOrEqual(90);
    // MCP writes no longer propose: there is nothing to poll.
    expect(mcpToolsetNames()).not.toContain('ai-proposals');
  });

  it('write tools are listed only with write access; credential commands never', () => {
    const toolsets = ['ocpp-2-1-commands', 'ocpp-1-6-commands', 'stations'];
    const withWrites = mcpToolset(toolsets, undefined, { writes: true });
    const readOnly = mcpToolset(toolsets, undefined, { writes: false });
    const writeNames = [...withWrites.byName.keys()].filter((n) => isMcpWriteTool(n));
    expect(writeNames.length).toBeGreaterThan(0);
    for (const name of writeNames) expect(readOnly.byName.has(name)).toBe(false);
    for (const name of readOnly.byName.keys()) expect(isMcpWriteTool(name)).toBe(false);
    // The station credential commands have no MCP tool, writes on or off.
    for (const operationId of [
      'ocppv21_SetVariables',
      'ocppv21_SetNetworkProfile',
      'ocppv16_ChangeConfiguration',
      'setStationCredentials',
      'rotateStationCredentials',
    ]) {
      expect(mcpOffers(operationId), operationId).toBe(false);
      const tool = AI_TOOL_CATALOG.find((t) => t.operationId === operationId);
      if (tool !== undefined) {
        expect(withWrites.byName.has(tool.name), tool.name).toBe(false);
        expect(isMcpWriteTool(tool.name), tool.name).toBe(false);
      }
    }
    expect(isMcpWriteTool('list_sites')).toBe(false);
    expect(isMcpWriteTool('no_such_tool')).toBe(false);
  });

  it('TC-AI-MCP-05: tools/list carries ttlMs and cacheScope', async () => {
    const handler = createMcpRequestHandler({} as FastifyInstance, { version: '0.0.0' });
    const caller: McpCaller = {
      userId: 'usr_000000000001',
      apiKeyId: '1',
      authorization: 'Bearer x',
      hasPermission: () => Promise.resolve(true),
      log: { debug() {}, info() {}, warn() {}, error() {} },
    };
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'unit', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } };
    const response = await handler.fetch(
      new Request('http://localhost/v1/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/list',
        },
        body: JSON.stringify(body),
      }),
      {
        parsedBody: body,
        authInfo: mcpAuthInfo({ caller, toolsets: ['sites'], writes: 'allowed' }),
      },
    );
    await handler.close();
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      result: { ttlMs: number; cacheScope: string; tools: { name: string }[] };
    };
    expect(json.result.ttlMs).toBe(MCP_TOOLS_LIST_TTL_MS);
    expect(json.result.cacheScope).toBe('private');
    expect(json.result.tools.map((t) => t.name)).toContain('list_sites');
  });
});
