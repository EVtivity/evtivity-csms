// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { EnumDefinition } from '../parsers/enum-extractor.js';

export function generateEnumFile(enumDef: EnumDefinition): string {
  const lines: string[] = [];

  lines.push(`export const ${enumDef.typeName} = {`);
  for (const value of enumDef.values) {
    const key = sanitizeEnumKey(value);
    lines.push(`  ${key}: '${value}',`);
  }
  lines.push('} as const;');
  lines.push('');
  lines.push(
    `export type ${enumDef.typeName} = (typeof ${enumDef.typeName})[keyof typeof ${enumDef.typeName}];`,
  );

  return lines.join('\n') + '\n';
}

function sanitizeEnumKey(value: string): string {
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(value)) {
    return value;
  }
  return `'${value}'`;
}
