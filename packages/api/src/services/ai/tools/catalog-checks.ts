// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Checks of the tool catalog against the policy. The codegen runs them on
 * the live OpenAPI spec and refuses to write a catalog with a problem; the
 * unit tests run them on the committed catalog (TC-AI-T-01, TC-AI-R-01).
 */

import type { AiCatalogOperation, AiCatalogTool } from './catalog-types.js';
import { CASE_PINS } from './policy.js';
import type { ToolPolicy } from './policy.js';
import { isSecretShapedKey } from '@evtivity/ai/redact';

/** Every operation has a policy entry and every entry names an operation. */
export function policyCoverageProblems(
  operations: readonly AiCatalogOperation[],
  policy: Readonly<Record<string, ToolPolicy>>,
): string[] {
  const problems: string[] = [];
  const ids = new Set(operations.map((o) => o.operationId));
  for (const op of operations) {
    const entry = Object.prototype.hasOwnProperty.call(policy, op.operationId)
      ? policy[op.operationId]
      : undefined;
    if (entry === undefined) {
      problems.push(`${op.operationId}: no AI tool policy entry (add one to tools/policy.ts)`);
      continue;
    }
    if (entry.exposure === 'read' && op.method !== 'GET') {
      problems.push(`${op.operationId}: exposure 'read' on a ${op.method} operation`);
    }
    if (entry.exposure === 'write' && op.method === 'GET') {
      problems.push(`${op.operationId}: exposure 'write' on a GET operation`);
    }
    if (entry.exposure === 'never' && (entry.chatbot || entry.support !== null)) {
      problems.push(`${op.operationId}: a 'never' entry lists a surface`);
    }
    if (entry.support !== null && entry.exposure !== 'read') {
      problems.push(`${op.operationId}: the support surface takes reads only`);
    }
  }
  for (const id of Object.keys(policy)) {
    if (!ids.has(id)) problems.push(`${id}: policy entry for an operation that does not exist`);
  }
  return problems;
}

/**
 * A request field that names where data goes outside the company: an email
 * recipient, a webhook or callback URL, an endpoint. An assistant write that
 * sets one turns a prompt injection into a recurring leak after one confirm
 * click, so such a field is omitted or the tool is 'never'.
 */
export function isDestinationShapedKey(name: string): boolean {
  return (
    /recipient|webhook|callback|endpoint|destination|bucket|(?:url|uri|host)s?$/i.test(name) ||
    /^(?:notify|send|forward|reply)?to$|^b?cc$/i.test(name)
  );
}

/**
 * A request field that holds a contact address of a record: a driver's,
 * site's or operator's email or phone. Receipts, invoices, security notices
 * and reports go there, so an assistant write that changes one redirects
 * them after one confirm click. Such a field is omitted like a recipient, or
 * the tool is 'never'.
 */
export function isContactShapedKey(name: string): boolean {
  return /(?:email|phone|mobile)(?:address|number)?s?$/i.test(name);
}

/** The words of a camelCase or snake_case field name, lowercase. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter((w) => w !== '')
    .map((w) => w.toLowerCase());
}

const MONEY_WORDS = new Set([
  'amount',
  'amounts',
  'price',
  'prices',
  'fee',
  'fees',
  'credit',
  'credits',
  'cents',
  'balance',
  'balances',
]);

/**
 * A request field that holds money or stored value: a prepaid balance, an
 * amount, a price, a fee, a credit. Every write that moves money is 'never'
 * for the assistant, so such a field is omitted or the tool is 'never'
 * (a prepaid balance set after one confirm click pays for charging).
 */
export function isMoneyShapedKey(name: string): boolean {
  return /(?:cents|balance)$/i.test(name) || nameWords(name).some((w) => MONEY_WORDS.has(w));
}

/**
 * Writes whose money-shaped fields were reviewed and are not stored value.
 * Each entry gives the reason. A new money-shaped field elsewhere is omitted
 * or its tool is 'never'.
 */
export const MONEY_FIELDS_REVIEWED: Readonly<Record<string, string>> = {
  ocppv21_RequestStartTransaction:
    'OCPP 2.1 charging profile price schedules: protocol data the station shows and estimates with; billing uses the CSMS tariff',
  ocppv21_SetChargingProfile:
    'OCPP 2.1 charging profile price schedules: protocol data the station shows and estimates with; billing uses the CSMS tariff',
};

/** A JSON schema string format that names an address: an email or a URL. */
function isAddressFormat(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return false;
  const node = schema as Record<string, unknown>;
  const format = node['format'];
  if (format === 'email' || format === 'idn-email' || format === 'uri' || format === 'url') {
    return true;
  }
  // A nullable or union field keeps its format on a member.
  return ['anyOf', 'oneOf', 'allOf'].some((key) => {
    const list = node[key];
    return Array.isArray(list) && list.some(isAddressFormat);
  });
}

/** Every property name of a JSON schema, at any depth, with its path. */
function schemaFieldPaths(
  schema: unknown,
  prefix = '',
): { path: string; name: string; schema: unknown }[] {
  if (schema === null || typeof schema !== 'object') return [];
  const node = schema as Record<string, unknown>;
  const out: { path: string; name: string; schema: unknown }[] = [];
  const properties = node['properties'];
  if (properties !== null && typeof properties === 'object') {
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      out.push({ path: `${prefix}${name}`, name, schema: child });
      out.push(...schemaFieldPaths(child, `${prefix}${name}.`));
    }
  }
  if (node['items'] !== undefined) out.push(...schemaFieldPaths(node['items'], `${prefix}[].`));
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const list = node[key];
    if (Array.isArray(list)) for (const child of list) out.push(...schemaFieldPaths(child, prefix));
  }
  return out;
}

function argumentNames(tool: AiCatalogTool): Set<string> {
  return new Set([...tool.pathParams, ...tool.queryParams, ...tool.bodyParams]);
}

/**
 * Exposed tools: a pinned argument is a path or query parameter, no
 * secret-shaped argument is left in, and no response field is secret-shaped
 * unless the policy lists it as reviewed and redacted (TC-AI-R-01).
 */
export function exposedToolProblems(
  tools: readonly AiCatalogTool[],
  policy: Readonly<Record<string, ToolPolicy>>,
): string[] {
  const problems: string[] = [];
  for (const tool of tools) {
    const entry = Object.prototype.hasOwnProperty.call(policy, tool.operationId)
      ? policy[tool.operationId]
      : undefined;
    if (entry === undefined || entry.exposure === 'never') {
      problems.push(`${tool.name}: in the catalog but its policy is 'never'`);
      continue;
    }
    const args = argumentNames(tool);
    for (const [name, pin] of Object.entries(entry.support?.pins ?? {})) {
      if (!(CASE_PINS as readonly string[]).includes(pin)) {
        problems.push(`${tool.name}: unknown pin '${pin}'`);
      }
      if (!tool.pathParams.includes(name) && !tool.queryParams.includes(name)) {
        problems.push(`${tool.name}: pins '${name}', which is not a path or query parameter`);
      }
    }
    for (const name of args) {
      if (isSecretShapedKey(name) && !entry.omit.includes(name)) {
        problems.push(
          `${tool.name}: secret-shaped argument '${name}' (omit it or make the tool 'never')`,
        );
      }
    }
    if (tool.method !== 'GET') {
      for (const { path, name, schema } of schemaFieldPaths(tool.validation)) {
        const topLevel = !path.includes('.');
        if (topLevel && entry.omit.includes(name)) continue;
        const kind =
          isDestinationShapedKey(name) || isAddressFormat(schema)
            ? 'destination'
            : isContactShapedKey(name)
              ? 'contact'
              : isMoneyShapedKey(name) && !Object.hasOwn(MONEY_FIELDS_REVIEWED, tool.operationId)
                ? 'money'
                : null;
        if (kind == null) continue;
        problems.push(
          topLevel
            ? `${tool.name}: ${kind} argument '${name}' (omit it or make the tool 'never')`
            : `${tool.name}: ${kind} field '${path}' (make the tool 'never')`,
        );
      }
    }
    for (const field of tool.responseFields) {
      if (isSecretShapedKey(field) && !entry.redactedFields.includes(field)) {
        problems.push(
          `${tool.name}: secret-shaped response field '${field}' (make the tool 'never')`,
        );
      }
    }
  }
  return problems;
}
