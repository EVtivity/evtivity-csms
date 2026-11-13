// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  generateCommonTypesIndex,
  generateEnumsIndex,
  generateMessagesIndex,
  generateRootIndex,
  generateValidatorsIndex,
} from '../generators/index-generator.js';
import type { ActionInfo, ActionPair, MessageType } from '../parsers/action-extractor.js';
import type { JsonSchemaDefinition } from '../parsers/schema-parser.js';

function info(action: string, messageType: MessageType): ActionInfo {
  return { action, messageType, schema: {} as ActionInfo['schema'] };
}

const PAIRS = new Map<string, ActionPair>([
  [
    'Reset',
    { action: 'Reset', request: info('Reset', 'Request'), response: info('Reset', 'Response') },
  ],
  ['Authorize', { action: 'Authorize', request: info('Authorize', 'Request') }],
  ['DataTransfer', { action: 'DataTransfer', response: info('DataTransfer', 'Response') }],
  ['CustomData', { action: 'CustomData', request: info('CustomData', 'Standalone') }],
]);

describe('index generators', () => {
  it('exports enums and common types sorted by name', () => {
    const enums = new Map([
      ['b', { name: 'b', typeName: 'ZetaEnumType', values: ['A'] }],
      ['a', { name: 'a', typeName: 'AlphaEnumType', values: ['B'] }],
    ]);
    expect(generateEnumsIndex(enums)).toBe(
      "export { AlphaEnumType } from './AlphaEnumType.js';\nexport { ZetaEnumType } from './ZetaEnumType.js';\n",
    );
    const types = new Map<string, JsonSchemaDefinition>([
      ['StatusInfoType', { name: 'StatusInfoType', type: 'object' } as JsonSchemaDefinition],
      [
        'ChargingProfileType',
        { name: 'ChargingProfileType', type: 'object' } as JsonSchemaDefinition,
      ],
    ]);
    expect(generateCommonTypesIndex(types)).toBe(
      "export type { ChargingProfileType } from './ChargingProfileType.js';\nexport type { StatusInfoType } from './StatusInfoType.js';\n",
    );
  });

  it('exports request and response types per action, a standalone type without a suffix', () => {
    expect(generateMessagesIndex(PAIRS).trim().split('\n')).toEqual([
      "export type { AuthorizeRequest } from './AuthorizeRequest.js';",
      "export type { CustomData } from './CustomData.js';",
      "export type { DataTransferResponse } from './DataTransferResponse.js';",
      "export type { ResetRequest } from './ResetRequest.js';",
      "export type { ResetResponse } from './ResetResponse.js';",
    ]);
  });

  it('exports validators, with the fit functions when asked', () => {
    const plain = generateValidatorsIndex(PAIRS).trim().split('\n');
    expect(plain).toContain("export { validateResetRequest } from './ResetRequest.validator.js';");
    expect(plain).toContain("export { validateCustomData } from './CustomData.validator.js';");
    const fit = generateValidatorsIndex(PAIRS, { fit: true }).trim().split('\n');
    expect(fit).toContain(
      "export { validateResetRequest, fitResetRequest } from './ResetRequest.validator.js';",
    );
    expect(fit).toContain(
      "export { validateDataTransferResponse, fitDataTransferResponse } from './DataTransferResponse.validator.js';",
    );
    expect(fit).toHaveLength(5);
  });

  it('builds the root index over every generated folder', () => {
    const root = generateRootIndex();
    expect(root).toContain("export * from './validators/index.js';");
    expect(root).toContain("export { ActionRegistry } from './registry.js';");
    expect(root.endsWith('\n')).toBe(true);
  });
});
