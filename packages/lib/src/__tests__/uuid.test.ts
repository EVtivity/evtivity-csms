// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUuidV4 } from '../uuid.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomUuidV4', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a version 4 UUID', () => {
    expect(randomUuidV4()).toMatch(UUID_V4);
  });

  it('returns a new id on every call', () => {
    const ids = new Set(Array.from({ length: 100 }, () => randomUuidV4()));
    expect(ids.size).toBe(100);
  });

  it('works without crypto.randomUUID (a page served over plain HTTP)', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
    expect(globalThis.crypto.randomUUID).toBeUndefined();
    expect(randomUuidV4()).toMatch(UUID_V4);
  });

  it('sets the version and variant bits whatever the random bytes are', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(0xff),
    });
    expect(randomUuidV4()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });
});
