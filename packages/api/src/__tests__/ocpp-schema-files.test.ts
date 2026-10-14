// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { ocppSchemaFilePath, readOcppSchemaFile } from '../lib/ocpp-schema-files.js';

const schemasRoot = path.resolve(import.meta.dirname, '../../../../schemas');

describe('OCPP schema file reader', () => {
  it('resolves request schema names under the schemas folder', () => {
    expect(ocppSchemaFilePath('ocpp-2.1/ResetRequest.json')).toBe(
      path.join(schemasRoot, 'ocpp-2.1', 'ResetRequest.json'),
    );
    expect(ocppSchemaFilePath('ocpp-1.6/Reset.json')).toBe(
      path.join(schemasRoot, 'ocpp-1.6', 'Reset.json'),
    );
  });

  it('refuses anything that is not a schema name, traversal included', async () => {
    for (const relativePath of [
      '../package.json',
      'ocpp-2.1/../../package.json',
      'ocpp-2.1/..%2F..%2Fpackage.json',
      '/etc/passwd',
      'ocpp-2.1//etc/passwd.json',
      'ocpp-2.1\\..\\..\\package.json',
      'ocpp-3.0/ResetRequest.json',
      'ocpp-2.1/ResetRequest.json\0.txt',
    ]) {
      expect(ocppSchemaFilePath(relativePath)).toBeNull();
      await expect(readOcppSchemaFile(relativePath)).resolves.toBeNull();
    }
  });

  it('reads a schema file', async () => {
    const content = await readOcppSchemaFile('ocpp-2.1/ResetRequest.json');
    expect(content).not.toBeNull();
    expect(JSON.parse(content ?? '{}')).toHaveProperty('properties');
  });
});
