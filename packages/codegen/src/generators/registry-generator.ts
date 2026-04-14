// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { ActionPair } from '../parsers/action-extractor.js';

export function generateRegistryFile(actionPairs: Map<string, ActionPair>): string {
  const actions = [...actionPairs.entries()]
    .filter(([, pair]) => pair.request != null && pair.response != null)
    .sort(([a], [b]) => a.localeCompare(b));

  const lines: string[] = [];

  for (const [, pair] of actions) {
    const action = pair.action;
    const reqSuffix = pair.request?.messageType === 'Standalone' ? '' : 'Request';
    lines.push(
      `import { validate${action}${reqSuffix} } from './validators/${action}${reqSuffix}.validator.js';`,
    );
    lines.push(
      `import { validate${action}Response } from './validators/${action}Response.validator.js';`,
    );
  }
  lines.push('');

  lines.push(`export const ActionRegistry = {`);
  for (const [, pair] of actions) {
    const action = pair.action;
    const reqSuffix = pair.request?.messageType === 'Standalone' ? '' : 'Request';
    lines.push(`  ${action}: {`);
    lines.push(`    validateRequest: validate${action}${reqSuffix},`);
    lines.push(`    validateResponse: validate${action}Response,`);
    lines.push(`  },`);
  }
  lines.push('} as const;');
  lines.push('');
  lines.push('export type ActionName = keyof typeof ActionRegistry;');

  return lines.join('\n') + '\n';
}
