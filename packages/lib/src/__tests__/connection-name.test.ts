// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  connectionName,
  CONNECTION_NAME_PREFIX,
  LEGACY_CONNECTION_NAME,
} from '../connection-name.js';

const pkg = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'),
) as { version: string };

describe('connectionName', () => {
  it('is evtivity@ plus the package version', () => {
    expect(connectionName()).toBe(`evtivity@${pkg.version}`);
    expect(connectionName().startsWith(CONNECTION_NAME_PREFIX)).toBe(true);
  });

  it('differs from the postgres.js default that older releases send', () => {
    expect(LEGACY_CONNECTION_NAME).toBe('postgres.js');
    expect(connectionName()).not.toBe(LEGACY_CONNECTION_NAME);
  });

  it('fits the 63-byte application_name limit', () => {
    expect(Buffer.byteLength(connectionName())).toBeLessThanOrEqual(63);
  });
});
