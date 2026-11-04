// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  DEPOT_SYSTEM_PASSWORD_LENGTH,
  generateDepotSystemPassword,
  hashDepotSystemPassword,
  verifyDepotSystemPassword,
} from '../lib/depot-system-password.js';

describe('depot system passwords', () => {
  it('generates 32 characters of the unambiguous alphabet', () => {
    const password = generateDepotSystemPassword();
    expect(password).toHaveLength(DEPOT_SYSTEM_PASSWORD_LENGTH);
    expect(password).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/);
    expect(generateDepotSystemPassword()).not.toBe(password);
  });

  it('hashes with the station password parameters (19 MiB, t=2, p=1)', async () => {
    const hash = await hashDepotSystemPassword('a-password');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyDepotSystemPassword(hash, 'a-password')).toBe(true);
    expect(await verifyDepotSystemPassword(hash, 'another')).toBe(false);
  });

  it('refuses an unknown system and a malformed hash', async () => {
    expect(await verifyDepotSystemPassword(null, 'a-password')).toBe(false);
    expect(await verifyDepotSystemPassword('not-a-hash', 'a-password')).toBe(false);
  });
});
