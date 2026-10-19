// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { ActionPair } from '../parsers/action-extractor.js';

export interface RegistryOptions {
  /** Entries also carry fitRequest and fitResponse (OCPP 2.0.1, see ValidatorOptions). */
  fit?: boolean;
}

export function generateRegistryFile(
  actionPairs: Map<string, ActionPair>,
  options: RegistryOptions = {},
): string {
  const fit = options.fit === true;
  const actions = [...actionPairs.entries()]
    .filter(([, pair]) => pair.request != null && pair.response != null)
    .sort(([a], [b]) => a.localeCompare(b));

  const lines: string[] = [];

  for (const [, pair] of actions) {
    const action = pair.action;
    const reqSuffix = pair.request?.messageType === 'Standalone' ? '' : 'Request';
    const reqImports = fit
      ? `validate${action}${reqSuffix}, fit${action}${reqSuffix}`
      : `validate${action}${reqSuffix}`;
    const resImports = fit
      ? `validate${action}Response, fit${action}Response`
      : `validate${action}Response`;
    lines.push(`import { ${reqImports} } from './validators/${action}${reqSuffix}.validator.js';`);
    lines.push(`import { ${resImports} } from './validators/${action}Response.validator.js';`);
  }
  lines.push('');

  lines.push(`export const ActionRegistry = {`);
  for (const [, pair] of actions) {
    const action = pair.action;
    const reqSuffix = pair.request?.messageType === 'Standalone' ? '' : 'Request';
    lines.push(`  ${action}: {`);
    lines.push(`    validateRequest: validate${action}${reqSuffix},`);
    lines.push(`    validateResponse: validate${action}Response,`);
    if (fit) {
      lines.push(`    fitRequest: fit${action}${reqSuffix},`);
      lines.push(`    fitResponse: fit${action}Response,`);
    }
    lines.push(`  },`);
  }
  lines.push('} as const;');
  lines.push('');
  lines.push('export type ActionName = keyof typeof ActionRegistry;');

  return lines.join('\n') + '\n';
}
