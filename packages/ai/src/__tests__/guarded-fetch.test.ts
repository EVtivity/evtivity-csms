// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type { LookupAddress } from 'node:dns';
import type { AiRequest } from '../core/types.js';

// Test DNS: internal.ai.example resolves to a private address.
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  const lookup = ((hostname: string, options: unknown, callback: unknown) => {
    if (hostname !== 'internal.ai.example') {
      (actual.lookup as (...args: unknown[]) => void)(hostname, options, callback);
      return;
    }
    setImmediate(() => {
      (callback as (err: null, records: LookupAddress[]) => void)(null, [
        { address: '10.0.0.1', family: 4 },
      ]);
    });
  }) as typeof actual.lookup;
  return { ...actual, default: { ...actual, lookup }, lookup };
});

const { blockedDestinationOf } = await import('@evtivity/lib/safe-fetch');
const { createGuardedFetch } = await import('../core/guarded-fetch.js');
const { createOpenAiAdapter } = await import('../providers/openai/adapter.js');

describe('createGuardedFetch', () => {
  it('refuses a base host that resolves to a private address', async () => {
    const guarded = createGuardedFetch(false);
    const err = await guarded('https://internal.ai.example/v1/models').catch((e: unknown) => e);
    expect(blockedDestinationOf(err)?.address).toBe('10.0.0.1');
  });

  it('refuses a private IP literal', async () => {
    const err = await createGuardedFetch(false)('http://10.0.0.1/v1').catch((e: unknown) => e);
    expect(blockedDestinationOf(err)).not.toBeNull();
  });

  it('refuses cloud metadata even when private networks are allowed', async () => {
    const err = await createGuardedFetch(true)('http://169.254.169.254/latest').catch(
      (e: unknown) => e,
    );
    expect(blockedDestinationOf(err)?.address).toBe('169.254.169.254');
  });

  it('makes an adapter with that fetch fail instead of sending the key', async () => {
    const guarded = createGuardedFetch(false);
    const outcomes: unknown[] = [];
    const spy = vi.fn((...args: Parameters<typeof fetch>) =>
      guarded(...args).catch((err: unknown) => {
        outcomes.push(err);
        throw err;
      }),
    );
    const adapter = createOpenAiAdapter({
      apiKey: 'sk-test',
      baseUrl: 'https://internal.ai.example/v1',
      fetch: spy,
    });
    const request: AiRequest = {
      model: 'gpt-4.1-mini',
      system: [{ text: 'System.', cacheable: true }],
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }],
      tools: [],
      effort: 'medium',
    };
    const run = (): Promise<unknown> => adapter.complete(request, new AbortController().signal);
    await expect(run()).rejects.toThrow();
    expect(spy).toHaveBeenCalled();
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.every((err) => blockedDestinationOf(err)?.address === '10.0.0.1')).toBe(true);
  });
});
