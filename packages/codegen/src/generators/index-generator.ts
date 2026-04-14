// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { ActionPair } from '../parsers/action-extractor.js';
import type { EnumDefinition } from '../parsers/enum-extractor.js';
import type { JsonSchemaDefinition } from '../parsers/schema-parser.js';

export function generateEnumsIndex(allEnums: Map<string, EnumDefinition>): string {
  const lines: string[] = [];
  const sorted = [...allEnums.values()].sort((a, b) => a.typeName.localeCompare(b.typeName));

  for (const enumDef of sorted) {
    lines.push(`export { ${enumDef.typeName} } from './${enumDef.typeName}.js';`);
  }

  return lines.join('\n') + '\n';
}

export function generateCommonTypesIndex(commonTypes: Map<string, JsonSchemaDefinition>): string {
  const lines: string[] = [];
  const sorted = [...commonTypes.keys()].sort();

  for (const typeName of sorted) {
    lines.push(`export type { ${typeName} } from './${typeName}.js';`);
  }

  return lines.join('\n') + '\n';
}

export function generateMessagesIndex(actionPairs: Map<string, ActionPair>): string {
  const lines: string[] = [];
  const actions = [...actionPairs.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [action, pair] of actions) {
    if (pair.request != null) {
      const suffix = pair.request.messageType === 'Standalone' ? '' : 'Request';
      lines.push(`export type { ${action}${suffix} } from './${action}${suffix}.js';`);
    }
    if (pair.response != null) {
      lines.push(`export type { ${action}Response } from './${action}Response.js';`);
    }
  }

  return lines.join('\n') + '\n';
}

export function generateValidatorsIndex(actionPairs: Map<string, ActionPair>): string {
  const lines: string[] = [];
  const actions = [...actionPairs.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [action, pair] of actions) {
    if (pair.request != null) {
      const suffix = pair.request.messageType === 'Standalone' ? '' : 'Request';
      lines.push(`export { validate${action}${suffix} } from './${action}${suffix}.validator.js';`);
    }
    if (pair.response != null) {
      lines.push(`export { validate${action}Response } from './${action}Response.validator.js';`);
    }
  }

  return lines.join('\n') + '\n';
}

export function generateRootIndex(): string {
  const lines: string[] = [];

  lines.push(`export * from './enums/index.js';`);
  lines.push(`export * from './types/common/index.js';`);
  lines.push(`export * from './types/messages/index.js';`);
  lines.push(`export * from './validators/index.js';`);
  lines.push(`export { ActionRegistry } from './registry.js';`);
  lines.push(`export type { ActionName } from './registry.js';`);
  lines.push(
    `export type { ActionHandler, HandlerContext, RequestType, ResponseType } from './handlers.js';`,
  );

  return lines.join('\n') + '\n';
}
