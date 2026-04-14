// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { ActionPair } from '../parsers/action-extractor.js';

export function generateHandlerFile(actionPairs: Map<string, ActionPair>): string {
  const actions = [...actionPairs.entries()]
    .filter(([, pair]) => pair.request != null && pair.response != null)
    .sort(([a], [b]) => a.localeCompare(b));

  const lines: string[] = [];

  lines.push(`import type { ActionName } from './registry.js';`);

  for (const [, pair] of actions) {
    const action = pair.action;
    const reqSuffix = pair.request?.messageType === 'Standalone' ? '' : 'Request';
    const reqTypeName = `${action}${reqSuffix}`;
    lines.push(`import type { ${reqTypeName} } from './types/messages/${reqTypeName}.js';`);
    lines.push(`import type { ${action}Response } from './types/messages/${action}Response.js';`);
  }
  lines.push('');

  lines.push('export interface HandlerContext {');
  lines.push('  stationId: string;');
  lines.push('}');
  lines.push('');

  lines.push('type RequestTypeMap = {');
  for (const [, pair] of actions) {
    const action = pair.action;
    const reqSuffix = pair.request?.messageType === 'Standalone' ? '' : 'Request';
    lines.push(`  ${action}: ${action}${reqSuffix};`);
  }
  lines.push('};');
  lines.push('');

  lines.push('type ResponseTypeMap = {');
  for (const [, pair] of actions) {
    lines.push(`  ${pair.action}: ${pair.action}Response;`);
  }
  lines.push('};');
  lines.push('');

  lines.push('export type RequestType<A extends ActionName> = RequestTypeMap[A];');
  lines.push('export type ResponseType<A extends ActionName> = ResponseTypeMap[A];');
  lines.push('');

  lines.push('export interface ActionHandler<A extends ActionName> {');
  lines.push('  handle(ctx: HandlerContext, request: RequestType<A>): Promise<ResponseType<A>>;');
  lines.push('}');

  return lines.join('\n') + '\n';
}
