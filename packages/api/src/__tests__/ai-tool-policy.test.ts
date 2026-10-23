// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { DOCS_SEARCH_OPERATION_ID } from '../services/ai/docs/docs-search.js';
import { describe, expect, it } from 'vitest';
import { AI_OPERATIONS, AI_TOOL_CATALOG } from '../services/ai/tools/catalog.js';
import type { AiCatalogTool } from '../services/ai/tools/catalog-types.js';
import {
  exposedToolProblems,
  isContactShapedKey,
  isDestinationShapedKey,
  isMoneyShapedKey,
  MONEY_FIELDS_REVIEWED,
  policyCoverageProblems,
} from '../services/ai/tools/catalog-checks.js';
import { AI_TOOL_POLICY, surfaceOffers, toolPolicy } from '../services/ai/tools/policy.js';
import { chatbotToolset, supportToolset } from '../services/ai/surfaces/toolsets.js';
import { isSecretShapedKey } from '@evtivity/ai/redact';

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
    // The documentation search reads public docs only, so it needs no pin.
    expect(toolset.byName.get('docs_search')?.tool.operationId).toBe(DOCS_SEARCH_OPERATION_ID);
    for (const e of toolset.byName.values()) {
      expect(e.tool.method).toBe('GET');
      if (e.tool.operationId === DOCS_SEARCH_OPERATION_ID) continue;
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
    expect([...toolset.byName.keys()]).toEqual(['docs_search', 'get_support_case']);
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

  it('no assistant write can set an outbound destination', () => {
    for (const [id, field] of [
      ['createReportSchedule', 'recipientEmails'],
      ['updateReportSchedule', 'recipientEmails'],
      ['createEventAlertRule', 'notifyRecipient'],
      ['updateEventAlertRule', 'notifyRecipient'],
    ] as const) {
      expect(toolPolicy(id).omit, id).toContain(field);
    }
    expect(toolPolicy('updateOcppEventSettings').exposure).toBe('never');
    for (const name of [
      'recipient',
      'recipientEmails',
      'notifyRecipient',
      'url',
      'webhookUrl',
      // Security review 2, AI I2.
      'host',
      'smtpHost',
      'bucket',
      'destination',
      'notifyTo',
      'to',
      'cc',
      'bcc',
    ]) {
      expect(isDestinationShapedKey(name), name).toBe(true);
    }
    for (const name of ['email', 'phone', 'contactEmail', 'notifyChannel', 'security', 'curve']) {
      expect(isDestinationShapedKey(name), name).toBe(false);
    }
  });

  it('hides driver and site email and phone from assistant writes (owner decision 2026-10-23)', () => {
    for (const [id, fields] of [
      ['createDriver', ['email', 'phone']],
      ['updateDriver', ['email', 'phone']],
      ['createSite', ['contactEmail', 'contactPhone']],
      ['updateSite', ['contactEmail', 'contactPhone']],
      ['upsertNeviStationData', ['operatorEmail', 'operatorPhone']],
    ] as const) {
      for (const field of fields) expect(toolPolicy(id).omit, `${id} ${field}`).toContain(field);
    }
    for (const name of [
      'email',
      'phone',
      'contactEmail',
      'operatorPhone',
      'emails',
      'phoneNumber',
      'emailAddress',
      'mobile',
      'mobileNumber',
    ]) {
      expect(isContactShapedKey(name), name).toBe(true);
    }
    for (const name of ['emailVerified', 'phoneNumberType', 'notifyChannel', 'telemetry']) {
      expect(isContactShapedKey(name), name).toBe(false);
    }
    expect(exposedToolProblems(AI_TOOL_CATALOG, AI_TOOL_POLICY)).toEqual([]);
  });

  it('the gate fails on a write with a contact field that is not omitted', () => {
    const base = AI_TOOL_CATALOG.find((t) => t.operationId === 'updateSite') as AiCatalogTool;
    const props = base.validation['properties'] as Record<string, unknown>;
    // The committed catalog drops omitted fields, so put them back.
    const leaky: AiCatalogTool = {
      ...base,
      validation: {
        ...base.validation,
        properties: {
          ...props,
          contactEmail: { type: 'string' },
          contactPhone: { type: 'string' },
        },
      },
    };
    expect(props['contactEmail']).toBeUndefined();
    const problems = exposedToolProblems([leaky], {
      ...AI_TOOL_POLICY,
      updateSite: { ...toolPolicy('updateSite'), omit: [] },
    });
    expect(problems.some((p) => p.includes("contact argument 'contactEmail'"))).toBe(true);
    expect(problems.some((p) => p.includes("contact argument 'contactPhone'"))).toBe(true);
  });

  it('the gate fails on a write with a destination field', () => {
    const base = AI_TOOL_CATALOG.find((t) => t.operationId === 'updateSite') as AiCatalogTool;
    const props = base.validation['properties'] as Record<string, unknown>;
    const leaky: AiCatalogTool = {
      ...base,
      validation: {
        ...base.validation,
        properties: {
          ...props,
          webhookUrl: { type: 'string' },
          alerts: { type: 'array', items: { type: 'object', properties: { recipient: {} } } },
        },
      },
    };
    expect(exposedToolProblems([leaky], AI_TOOL_POLICY)).toEqual([
      "update_site: destination argument 'webhookUrl' (omit it or make the tool 'never')",
      "update_site: destination field 'alerts.[].recipient' (make the tool 'never')",
    ]);
  });

  it('no assistant write can set a prepaid balance or another money field (review 2, AI M1)', () => {
    expect(toolPolicy('createToken').omit).toContain('prepaidBalanceCents');
    expect(toolPolicy('updateToken').omit).toEqual(
      expect.arrayContaining(['prepaidBalanceCents', 'expectedPrepaidBalanceCents']),
    );
    for (const name of [
      'prepaidBalanceCents',
      'balance',
      'amountCents',
      'refundAmount',
      'unitPrice',
      'platformFeePercent',
      'creditLimitCents',
      'credit',
    ]) {
      expect(isMoneyShapedKey(name), name).toBe(true);
    }
    for (const name of ['name', 'percentage', 'feedback', 'priority', 'creditor', 'balanced']) {
      expect(isMoneyShapedKey(name), name).toBe(false);
    }
    // Only reviewed protocol payloads keep money-shaped fields.
    expect(Object.keys(MONEY_FIELDS_REVIEWED).sort()).toEqual([
      'ocppv21_RequestStartTransaction',
      'ocppv21_SetChargingProfile',
    ]);
    expect(exposedToolProblems(AI_TOOL_CATALOG, AI_TOOL_POLICY)).toEqual([]);
  });

  it('the gate fails on a write with a money field that is not omitted', () => {
    const base = AI_TOOL_CATALOG.find((t) => t.operationId === 'updateSite') as AiCatalogTool;
    const props = base.validation['properties'] as Record<string, unknown>;
    const leaky: AiCatalogTool = {
      ...base,
      validation: {
        ...base.validation,
        properties: {
          ...props,
          balanceCents: { type: 'integer' },
          rates: { type: 'array', items: { type: 'object', properties: { unitPrice: {} } } },
        },
      },
    };
    expect(exposedToolProblems([leaky], AI_TOOL_POLICY)).toEqual([
      "update_site: money argument 'balanceCents' (omit it or make the tool 'never')",
      "update_site: money field 'rates.[].unitPrice' (make the tool 'never')",
    ]);
  });

  it('the gate fails on a write field with an email or URI format (review 2, AI I2)', () => {
    const base = AI_TOOL_CATALOG.find((t) => t.operationId === 'updateSite') as AiCatalogTool;
    const props = base.validation['properties'] as Record<string, unknown>;
    const leaky: AiCatalogTool = {
      ...base,
      validation: {
        ...base.validation,
        properties: {
          ...props,
          archive: { type: 'string', format: 'uri' },
          owner: { anyOf: [{ type: 'string', format: 'email' }, { type: 'null' }] },
        },
      },
    };
    expect(exposedToolProblems([leaky], AI_TOOL_POLICY)).toEqual([
      "update_site: destination argument 'archive' (omit it or make the tool 'never')",
      "update_site: destination argument 'owner' (omit it or make the tool 'never')",
    ]);
  });

  it('the assistant writes no notification template', () => {
    for (const op of ['upsertNotificationTemplate', 'deleteNotificationTemplate']) {
      expect(toolPolicy(op).exposure, op).toBe('never');
    }
    // Every operation that writes a notification, OCPP event rule or station
    // message template is never; reads, the preview (it writes nothing) and the
    // OCPP rule delete (it removes a rule, writes no template) may stay.
    const templateWrites = AI_OPERATIONS.filter(
      (o) =>
        o.method !== 'GET' &&
        /NotificationTemplate|^updateOcppEventSettings$|StationMessageTemplate|EmailWrapper/.test(
          o.operationId,
        ) &&
        !o.operationId.startsWith('preview'),
    ).map((o) => o.operationId);
    expect(templateWrites.length).toBeGreaterThan(3);
    for (const op of templateWrites) {
      expect(toolPolicy(op).exposure, op).toBe('never');
    }
    const names = [...chatbotToolset(ALL_CATEGORIES, AI_TOOL_CATALOG).byName.keys()];
    expect(names).not.toContain('upsert_notification_template');
    expect(names).not.toContain('delete_notification_template');
  });

  it('the assistant cannot change a site AI budget or insight switch (review 2, AI I4)', () => {
    expect(toolPolicy('updateSite').omit).toEqual(
      expect.arrayContaining(['aiMonthlyTokenBudget', 'aiInsightsEnabled']),
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
