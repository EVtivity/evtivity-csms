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
import { isSecretShapedKey } from './redact.js';

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
