// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ value: '', queries: 0 }));

vi.mock('@evtivity/database', () => ({
  client: () => {
    state.queries++;
    return Promise.resolve([{ value: state.value }]);
  },
}));
vi.mock('../../../lib/config.js', () => ({ config: { SETTINGS_ENCRYPTION_KEY: 'test-key' } }));
vi.mock('@evtivity/lib', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
  decryptString: (value: string, key: string) => {
    if (key !== 'test-key' || !value.startsWith('enc:')) throw new Error('bad ciphertext');
    return value.slice(4);
  },
}));

import {
  clearLocalContractCaCache,
  getLocalContractCa,
} from '../../../services/pki/local-ca-store.js';

const ENTRY = { cert: 'pem', key: 'key' };
const HIERARCHY = {
  moRoot: ENTRY,
  moSubCa1: { cert: 'pem' },
  moSubCa2: ENTRY,
  cpsRoot: ENTRY,
  cpsSubCa1: { cert: 'pem' },
  cpsSubCa2: { cert: 'pem' },
  cpsLeaf: ENTRY,
};
const BUNDLE = { version: 1, createdAt: '2026-10-04T00:00:00Z', iso2: HIERARCHY, iso20: HIERARCHY };

beforeEach(() => {
  clearLocalContractCaCache();
  state.queries = 0;
});

describe('getLocalContractCa', () => {
  it('is null when no CA was created', async () => {
    state.value = '';
    expect(await getLocalContractCa()).toBeNull();
  });

  it('decrypts and parses the bundle and caches it', async () => {
    state.value = `enc:${JSON.stringify(BUNDLE)}`;
    expect(await getLocalContractCa()).toEqual(BUNDLE);
    expect(await getLocalContractCa()).toEqual(BUNDLE);
    expect(state.queries).toBe(1);
    clearLocalContractCaCache();
    await getLocalContractCa();
    expect(state.queries).toBe(2);
  });

  it('is null when the value does not decrypt or is not a bundle', async () => {
    state.value = 'garbage';
    expect(await getLocalContractCa()).toBeNull();
    clearLocalContractCaCache();
    state.value = 'enc:{"version":1}';
    expect(await getLocalContractCa()).toBeNull();
  });
});
