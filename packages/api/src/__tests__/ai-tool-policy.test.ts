// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { AI_OPERATIONS, AI_TOOL_CATALOG } from '../services/ai/tools/catalog.js';
import type { AiCatalogTool } from '../services/ai/tools/catalog-types.js';
import {
  exposedToolProblems,
  policyCoverageProblems,
} from '../services/ai/tools/catalog-checks.js';
import { AI_TOOL_POLICY, surfaceOffers, toolPolicy } from '../services/ai/tools/policy.js';
import { chatbotToolset, supportToolset } from '../services/ai/surfaces/toolsets.js';
import { isSecretShapedKey } from '../services/ai/tools/redact.js';

const ALL_CATEGORIES = [...new Set(AI_TOOL_CATALOG.map((t) => t.category))];
const SUPPORT_CASE = {
  caseId: 'cas_000000000001',
  stationId: 'sta_000000000001',
  driverId: 'drv_000000000001',
  sessionIds: ['ses_000000000001'],
};

describe('AI tool policy and catalog', () => {
  it('TC-AI-T-01 every API operation has a policy entry and every entry an operation', () => {
    expect(AI_OPERATIONS.length).toBeGreaterThan(700);
    expect(policyCoverageProblems(AI_OPERATIONS, AI_TOOL_POLICY)).toEqual([]);
  });

  it('TC-AI-T-01 reports a missing entry, a stale entry and a method mismatch', () => {
    const ops = [
      { operationId: 'newRoute', method: 'GET' as const, path: '/v1/new' },
      { operationId: 'getStation', method: 'DELETE' as const, path: '/v1/stations/{id}' },
    ];
    const policy = {
      getStation: AI_TOOL_POLICY['getStation']!,
      staleRoute: AI_TOOL_POLICY['getStation']!,
    };
    const problems = policyCoverageProblems(ops, policy);
    expect(problems.some((p) => p.startsWith('newRoute: no AI tool policy entry'))).toBe(true);
    expect(problems.some((p) => p.startsWith('staleRoute:'))).toBe(true);
    expect(problems.some((p) => p.includes("exposure 'read' on a DELETE"))).toBe(true);
  });

  it('TC-AI-T-02 never tools are in no catalog and no surface toolset (B6)', () => {
    const neverIds = Object.entries(AI_TOOL_POLICY)
      .filter(([, p]) => p.exposure === 'never')
      .map(([id]) => id);
    const catalogIds = new Set(AI_TOOL_CATALOG.map((t) => t.operationId));
    for (const id of neverIds) expect(catalogIds.has(id)).toBe(false);
    const offered = new Set([
      ...chatbotToolset(ALL_CATEGORIES, AI_TOOL_CATALOG).byName.keys(),
      ...supportToolset(SUPPORT_CASE).byName.keys(),
    ]);
    for (const name of [
      'support_case_ai_assist',
      'send_ai_message',
      'confirm_ai_action',
      'create_api_key',
      'update_my_chatbot_ai_config',
      'update_my_support_ai_config',
      'get_stripe_settings',
      'get_adyen_settings',
      'list_settings',
      'get_setting',
      'get_pnc_settings',
      'list_css_stations',
      'refund_session_payment',
      'set_station_credentials',
    ]) {
      expect(offered.has(name)).toBe(false);
    }
    // No portal operation is a tool.
    for (const op of AI_OPERATIONS.filter((o) => o.path.startsWith('/v1/portal/'))) {
      expect(toolPolicy(op.operationId).exposure).toBe('never');
    }
  });

  it('TC-AI-T-10 the support surface has reads only, every one pinned to the case', () => {
    const toolset = supportToolset(SUPPORT_CASE);
    expect(toolset.byName.size).toBeGreaterThan(5);
    for (const e of toolset.byName.values()) {
      expect(e.tool.method).toBe('GET');
      const pinned = Object.keys(e.fixedArgs).length + Object.keys(e.allowedValues).length;
      expect(pinned).toBeGreaterThan(0);
    }
    for (const [id, p] of Object.entries(AI_TOOL_POLICY)) {
      if (p.exposure === 'write') expect(surfaceOffers(p, 'support'), id).toBe(false);
    }
  });

  it('leaves out support tools whose pin has no value (a case without station or driver)', () => {
    const toolset = supportToolset({
      caseId: 'cas_000000000001',
      stationId: null,
      driverId: null,
      sessionIds: [],
    });
    expect([...toolset.byName.keys()]).toEqual(['get_support_case']);
  });

  it('TC-AI-R-01 no exposed tool has a secret-shaped argument or response field', () => {
    expect(exposedToolProblems(AI_TOOL_CATALOG, AI_TOOL_POLICY)).toEqual([]);
    for (const tool of AI_TOOL_CATALOG) {
      const policy = toolPolicy(tool.operationId);
      for (const field of tool.responseFields) {
        if (isSecretShapedKey(field))
          expect(policy.redactedFields, `${tool.name}.${field}`).toContain(field);
      }
    }
  });

  it('TC-AI-R-01 the gate fails on a new secret-shaped field', () => {
    const base = AI_TOOL_CATALOG.find((t) => t.operationId === 'getStation') as AiCatalogTool;
    const leaky: AiCatalogTool = {
      ...base,
      responseFields: [...base.responseFields, 'webhookSecret', 'apiKeyEnc'],
    };
    const problems = exposedToolProblems([leaky], AI_TOOL_POLICY);
    expect(problems).toHaveLength(2);
    const argLeak: AiCatalogTool = { ...base, bodyParams: ['clientSecret'] };
    expect(exposedToolProblems([argLeak], AI_TOOL_POLICY)[0]).toContain(
      "secret-shaped argument 'clientSecret'",
    );
  });

  it('catalog tools have unique names, closed strict schemas and a validation schema', () => {
    const names = AI_TOOL_CATALOG.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of AI_TOOL_CATALOG) {
      expect(tool.name).toMatch(/^[a-z0-9_]{1,64}$/);
      expect(tool.validation['type']).toBe('object');
      if (tool.strict) {
        expect(tool.parameters['additionalProperties']).toBe(false);
        const props = Object.keys(tool.parameters['properties'] as Record<string, unknown>);
        expect(tool.parameters['required']).toEqual(props);
      }
    }
  });

  it('omitted arguments are not in the catalog (station passwords)', () => {
    for (const id of ['createStation', 'updateStation']) {
      const tool = AI_TOOL_CATALOG.find((t) => t.operationId === id) as AiCatalogTool;
      expect(tool.bodyParams).not.toContain('password');
      expect(Object.keys(tool.validation['properties'] as object)).not.toContain('password');
    }
  });
});
