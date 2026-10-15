// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { AI_WORKER_ACTIONS } from '@evtivity/lib/ai-proposals';
import { AI_TOOL_CATALOG } from '../services/ai/tools/catalog.js';
import { toolPolicy } from '../services/ai/tools/policy.js';

interface PropertySchema {
  enum?: readonly unknown[];
}

describe('AI worker actions match the tool catalog (TC-AI-WK-05)', () => {
  it.each(AI_WORKER_ACTIONS.map((a) => [a.operationId, a] as const))(
    '%s is a write tool with the same route and argument values',
    (operationId, action) => {
      expect(toolPolicy(operationId).exposure).toBe('write');
      const tool = AI_TOOL_CATALOG.find((t) => t.operationId === operationId);
      expect(tool).toBeDefined();
      if (tool == null) return;
      expect(tool.method).toBe(action.method);
      expect(tool.pathTemplate).toBe(action.path);
      const properties = (tool.validation as { properties?: Record<string, PropertySchema> })
        .properties;
      const constrained = { ...action.allowedArgs, ...mapValues(action.fixedArgs) };
      for (const [name, values] of Object.entries(constrained)) {
        const allowed = properties?.[name]?.enum;
        expect(allowed, `${operationId}.${name}`).toBeDefined();
        for (const value of values) expect(allowed).toContain(value);
      }
    },
  );
});

const MONEY_OR_SECURITY =
  /pay|refund|invoice|tariff|pric|bill|credit|fee|cost|certificate|password|security|firmware|configuration|variable|network/i;

/**
 * The two session ends a stuck-session insight may carry: the operator's EVSE
 * stop (online station, with ghost recovery) and the CSMS end of an offline
 * station's session. Each bills the session as the station's own stop would.
 */
const SESSION_END_ROUTES = new Map([
  ['stopActiveEvseSession', '/v1/stations/{id}/evses/{evseId}/stop-active-session'],
  ['endSession', '/v1/sessions/{id}/end'],
]);

describe('AI worker actions stay station commands and session ends (TC-AI-WK-05)', () => {
  it('TC-AI-WK-05 no action moves money or changes pricing, billing or security', () => {
    for (const action of AI_WORKER_ACTIONS) {
      const sessionEnd = SESSION_END_ROUTES.get(action.operationId);
      if (sessionEnd !== undefined) {
        expect(action.path, action.operationId).toBe(sessionEnd);
      } else {
        expect(action.path.startsWith('/v1/ocpp/commands/'), action.operationId).toBe(true);
      }
      expect(
        MONEY_OR_SECURITY.test(`${action.operationId} ${action.path}`),
        action.operationId,
      ).toBe(false);
    }
    expect(new Set(AI_WORKER_ACTIONS.map((a) => a.kind))).toEqual(
      new Set(['stop_transaction', 'end_session', 'soft_reset', 'change_availability']),
    );
  });

  it('keeps the session ends confirm-gated tools that MCP clients never get', async () => {
    const { AI_MCP_EXPOSURE } = await import('../services/ai/tools/policy.js');
    for (const operationId of SESSION_END_ROUTES.keys()) {
      expect(toolPolicy(operationId).exposure).toBe('write');
      expect(AI_MCP_EXPOSURE[operationId]).toBe(false);
    }
  });
});

function mapValues(fixed: Readonly<Record<string, string>>): Record<string, readonly string[]> {
  return Object.fromEntries(Object.entries(fixed).map(([k, v]) => [k, [v]]));
}
