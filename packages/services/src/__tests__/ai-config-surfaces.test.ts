// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The ops and driver AI surfaces: when each resolves (provider, key, an
// accepted base URL), the router model fallback, the decrypted company key,
// the adapter built with the send-time address guard, and the built-in
// prompts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptString } from '@evtivity/lib';
import type { AiSettings } from '@evtivity/lib/ai-config';
import { getProviderEntry } from '@evtivity/ai/core';

const h = vi.hoisted(() => ({
  created: [] as { provider: string; options: Record<string, unknown> }[],
  guarded: [] as boolean[],
  tracked: [] as unknown[],
}));

vi.mock('@evtivity/ai/providers', () => ({
  getProviderRegistry: () => ({
    create: (provider: string, options: Record<string, unknown>) => {
      h.created.push({ provider, options });
      return { provider, marker: 'adapter' };
    },
  }),
  createGuardedFetch: (allowPrivate: boolean) => {
    h.guarded.push(allowPrivate);
    return `guarded:${String(allowPrivate)}`;
  },
}));

vi.mock('../ai-alerts.js', () => ({
  trackAiProviderCalls: (adapter: unknown) => {
    h.tracked.push(adapter);
    return { tracked: adapter };
  },
}));

const ops = await import('../ai-ops-config.js');
const driver = await import('../driver-ai-config.js');
const opsPrompt = await import('../ai-ops-prompt.js');
const driverPrompt = await import('../driver-ai-prompt.js');

const KEY = 'test-encryption-key';

function settings(
  over: {
    provider?: 'anthropic' | 'deepseek' | null;
    apiKeyEnc?: string;
    baseUrl?: string;
    model?: string;
    enabled?: boolean;
  } = {},
): AiSettings {
  const surface = {
    enabled: over.enabled ?? true,
    provider: over.provider === undefined ? 'deepseek' : over.provider,
    model: over.model ?? '',
    effort: 'low',
    systemPrompt: '  Custom prompt  ',
  };
  const creds = {
    apiKeyEnc: over.apiKeyEnc ?? encryptString('sk-secret', KEY),
    baseUrl: over.baseUrl ?? '',
  };
  return {
    ops: surface,
    driver: surface,
    providers: { anthropic: creds, openai: creds, gemini: creds, deepseek: creds },
  } as unknown as AiSettings;
}

beforeEach(() => {
  h.created.length = 0;
  h.guarded.length = 0;
  h.tracked.length = 0;
});

describe.each([
  ['ops', ops.resolveOpsAiConfig],
  ['driver', driver.resolveDriverAiConfig],
] as const)('%s surface resolver', (_name, resolve) => {
  it('resolves with the decrypted key, the router model and the trimmed prompt', () => {
    const out = resolve(settings(), KEY, false);
    expect(out).toEqual({
      provider: 'deepseek',
      apiKey: 'sk-secret',
      baseUrl: '',
      model: getProviderEntry('deepseek').routerModel,
      effort: 'low',
      systemPrompt: 'Custom prompt',
      allowPrivateHosts: false,
    });
  });

  it('keeps the chosen model and an accepted base URL', () => {
    const out = resolve(
      settings({ model: 'big', baseUrl: 'https://llm.example.com/v1' }),
      KEY,
      false,
    );
    expect(out).toMatchObject({ model: 'big', baseUrl: 'https://llm.example.com/v1' });
  });

  it('answers null without a provider, without a key, or for a refused base URL', () => {
    expect(resolve(settings({ provider: null }), KEY, false)).toBeNull();
    expect(resolve(settings({ apiKeyEnc: '' }), KEY, false)).toBeNull();
    expect(resolve(settings({ baseUrl: 'http://10.0.0.1/v1' }), KEY, false)).toBeNull();
    expect(resolve(settings({ baseUrl: 'http://10.0.0.1/v1' }), KEY, true)).toMatchObject({
      baseUrl: 'http://10.0.0.1/v1',
      allowPrivateHosts: true,
    });
  });

  it('throws when the stored key cannot be decrypted', () => {
    expect(() => resolve(settings(), 'another-key', false)).toThrow();
  });
});

describe.each([
  ['ops', ops.createOpsAdapter],
  ['driver', driver.createDriverAiAdapter],
] as const)('%s adapter', (_name, create) => {
  it('builds a tracked adapter with the guarded fetch and no base URL for the official endpoint', () => {
    const adapter = create({
      provider: 'deepseek',
      apiKey: 'k',
      baseUrl: '',
      model: 'm',
      effort: 'low',
      systemPrompt: '',
    });
    expect(h.created).toEqual([
      { provider: 'deepseek', options: { apiKey: 'k', fetch: 'guarded:false' } },
    ]);
    expect(h.tracked).toHaveLength(1);
    expect(adapter).toEqual({ tracked: { provider: 'deepseek', marker: 'adapter' } });
  });

  it('passes a custom base URL and the private host allowance', () => {
    create({
      provider: 'anthropic',
      apiKey: 'k',
      baseUrl: 'http://localhost:8080',
      model: 'm',
      effort: 'low',
      systemPrompt: '',
      allowPrivateHosts: true,
    });
    expect(h.created[0]!.options).toEqual({
      apiKey: 'k',
      baseUrl: 'http://localhost:8080',
      fetch: 'guarded:true',
    });
  });
});

describe('isDriverAiUsable', () => {
  it('needs the switch, a provider, a key and an accepted endpoint', () => {
    expect(driver.isDriverAiUsable(settings(), false)).toBe(true);
    expect(driver.isDriverAiUsable(settings({ enabled: false }), false)).toBe(false);
    expect(driver.isDriverAiUsable(settings({ provider: null }), false)).toBe(false);
    expect(driver.isDriverAiUsable(settings({ apiKeyEnc: '' }), false)).toBe(false);
    expect(driver.isDriverAiUsable(settings({ baseUrl: 'ftp://x' }), false)).toBe(false);
  });
});

describe('built-in prompts', () => {
  it('pick the language and fall back to English', () => {
    expect(opsPrompt.defaultOpsPrompt('de')).toBe(opsPrompt.OPS_DEFAULT_PROMPTS.de);
    expect(opsPrompt.defaultOpsPrompt(null)).toBe(opsPrompt.OPS_DEFAULT_PROMPTS.en);
    expect(driverPrompt.defaultDriverAiPrompt('zh-TW')).toBe(
      driverPrompt.DRIVER_AI_DEFAULT_PROMPTS['zh-TW'],
    );
    expect(driverPrompt.defaultDriverAiPrompt(undefined)).toBe(
      driverPrompt.DRIVER_AI_DEFAULT_PROMPTS.en,
    );
  });

  it('recognize a default prompt in any language, ignoring line endings and spaces', () => {
    expect(opsPrompt.isDefaultOpsPrompt(`  ${opsPrompt.OPS_DEFAULT_PROMPTS.ko}\r\n`)).toBe(true);
    expect(opsPrompt.isDefaultOpsPrompt('My own prompt')).toBe(false);
    expect(driverPrompt.isDefaultDriverAiPrompt(driverPrompt.DRIVER_AI_DEFAULT_PROMPTS.es)).toBe(
      true,
    );
    expect(driverPrompt.isDefaultDriverAiPrompt(opsPrompt.OPS_DEFAULT_PROMPTS.es)).toBe(false);
  });

  it('keep the fixed rules separate from the editable prompt', () => {
    expect(opsPrompt.OPS_SECURITY_RULES).toContain('<untrusted');
    expect(driverPrompt.DRIVER_AI_RULES).toContain('needsOperator');
  });
});
