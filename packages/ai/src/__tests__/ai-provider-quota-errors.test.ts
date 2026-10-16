// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Out-of-credit and over-quota replies map to `quota_exceeded`, rate limits
 * stay `rate_limited`. Each reply shape comes from the provider's official
 * documentation, named in the test title:
 * - OpenAI: https://developers.openai.com/api/docs/guides/error-codes
 * - Anthropic: https://platform.claude.com/docs/en/api/errors and /api/rate-limits
 * - Gemini: https://ai.google.dev/gemini-api/docs/api-errors and the
 *   google.rpc.QuotaFailure detail of a RESOURCE_EXHAUSTED reply
 * - DeepSeek: https://api-docs.deepseek.com/quick_start/error_codes
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAiProviderError, providerErrorCodeForStatus } from '../core/errors.js';
import type { AiAdapter, AiAdapterOptions } from '../core/types.js';
import { CONTRACT_TEST_API_KEY } from '../__contract__/harness.js';
import { startMockProviderServer } from '../__contract__/mock-provider-server.js';
import type { MockProviderServer } from '../__contract__/mock-provider-server.js';
import { jsonErrorFixture } from '../__contract__/targets/wire.js';
import { createAnthropicAdapter } from '../providers/anthropic/adapter.js';
import { createDeepSeekAdapter } from '../providers/deepseek/adapter.js';
import { createGeminiAdapter } from '../providers/gemini/adapter.js';
import { createOpenAiAdapter } from '../providers/openai/adapter.js';

let server: MockProviderServer;
beforeEach(async () => {
  server = await startMockProviderServer();
});
afterEach(async () => {
  await server.close();
});

async function codeOf(
  create: (options: AiAdapterOptions) => AiAdapter,
  model: string,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<string> {
  server.enqueue(jsonErrorFixture(status, body, headers));
  const adapter = create({ apiKey: CONTRACT_TEST_API_KEY, baseUrl: server.baseUrl });
  try {
    await adapter.complete(
      {
        model,
        system: [{ text: 'System.', cacheable: true }],
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }],
        tools: [],
        effort: 'low',
      },
      new AbortController().signal,
    );
  } catch (err) {
    if (isAiProviderError(err)) return err.code;
    throw err;
  }
  throw new Error('expected a provider error');
}

const openAiError = (message: string, type: string, code: string) => ({
  error: { message, type, param: null, code },
});

describe('OpenAI quota replies (developers.openai.com error codes guide)', () => {
  const code = (status: number, body: unknown) =>
    codeOf(createOpenAiAdapter, 'gpt-5.5-mini', status, body);

  it.each([
    [
      'insufficient_quota',
      'You exceeded your current quota, please check your plan and billing details.',
    ],
    ['credit_balance_exhausted', 'Your organization has no prepaid credits remaining.'],
    ['organization_spend_limit_exceeded', 'Your organization reached its enforced spend limit.'],
    ['project_spend_limit_exceeded', 'Your project reached its enforced spend limit.'],
    [
      'organization_usage_limit_exceeded',
      'Your organization reached its OpenAI-assigned usage limit.',
    ],
  ])('429 %s is quota_exceeded', async (errorCode, message) => {
    expect(await code(429, openAiError(message, 'insufficient_quota', errorCode))).toBe(
      'quota_exceeded',
    );
  });

  it('429 rate_limit_exceeded stays rate_limited', async () => {
    expect(
      await code(
        429,
        openAiError('Rate limit reached for requests', 'requests', 'rate_limit_exceeded'),
      ),
    ).toBe('rate_limited');
  });
});

const anthropicError = (type: string, message: string, details?: Record<string, unknown>) => ({
  type: 'error',
  error: { type, message, ...(details !== undefined ? { details } : {}) },
  request_id: 'req_011CSHoEeqs5C35K2UUqR7Fy',
});

describe('Anthropic quota replies (platform.claude.com api/errors and api/rate-limits)', () => {
  const code = (status: number, body: unknown, headers?: Record<string, string>) =>
    codeOf(createAnthropicAdapter, 'claude-sonnet-5-5', status, body, headers);

  it('400 credit balance too low is quota_exceeded', async () => {
    expect(
      await code(
        400,
        anthropicError(
          'invalid_request_error',
          'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
        ),
      ),
    ).toBe('quota_exceeded');
  });

  it('402 billing_error is quota_exceeded', async () => {
    expect(
      await code(
        402,
        anthropicError(
          'billing_error',
          'There is an issue with your billing or payment information.',
        ),
      ),
    ).toBe('quota_exceeded');
  });

  it('429 enforced_spend_limit_reached (monthly tier cap) is quota_exceeded', async () => {
    expect(
      await code(
        429,
        anthropicError(
          'rate_limit_error',
          'You have reached your API usage limits: your organization has crossed its monthly API usage threshold.',
          { error_code: 'enforced_spend_limit_reached' },
        ),
      ),
    ).toBe('quota_exceeded');
  });

  it('400 specified (workspace) API usage limit is quota_exceeded', async () => {
    expect(
      await code(
        400,
        anthropicError(
          'invalid_request_error',
          'You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.',
        ),
      ),
    ).toBe('quota_exceeded');
  });

  it('429 rate_limit_error with retry-after stays rate_limited', async () => {
    expect(
      await code(429, anthropicError('rate_limit_error', 'Rate limited'), { 'retry-after': '7' }),
    ).toBe('rate_limited');
  });
});

const quotaFailure = (quotaId: string) => ({
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId,
          },
        ],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '41s' },
    ],
  },
});

describe('Gemini quota replies (ai.google.dev api-errors, google.rpc.QuotaFailure)', () => {
  const code = (status: number, body: unknown) =>
    codeOf(createGeminiAdapter, 'gemini-3-flash', status, body);

  it('429 RESOURCE_EXHAUSTED on a per-day quota is quota_exceeded', async () => {
    expect(await code(429, quotaFailure('GenerateRequestsPerDayPerProjectPerModel-FreeTier'))).toBe(
      'quota_exceeded',
    );
  });

  it('429 RESOURCE_EXHAUSTED on a per-minute limit stays rate_limited', async () => {
    expect(await code(429, quotaFailure('GenerateRequestsPerMinutePerProjectPerModel'))).toBe(
      'rate_limited',
    );
  });

  it('429 monthly spending cap is quota_exceeded', async () => {
    expect(
      await code(429, {
        error: {
          code: 429,
          message: 'Your project has exceeded its monthly spending cap.',
          status: 'RESOURCE_EXHAUSTED',
        },
      }),
    ).toBe('quota_exceeded');
  });

  it('402 depleted prepayment credits is quota_exceeded', async () => {
    expect(
      await code(402, {
        error: { code: 402, message: 'Your prepayment credits are depleted.', status: '' },
      }),
    ).toBe('quota_exceeded');
  });
});

describe('DeepSeek quota replies (api-docs.deepseek.com error codes)', () => {
  const code = (status: number, message: string) =>
    codeOf(createDeepSeekAdapter, 'deepseek-chat', status, {
      error: { message, type: 'unknown_error', param: null, code: 'invalid_request_error' },
    });

  it('402 Insufficient Balance is quota_exceeded', async () => {
    expect(await code(402, 'Insufficient Balance')).toBe('quota_exceeded');
  });

  it('429 Rate Limit Reached stays rate_limited', async () => {
    expect(await code(429, 'Rate Limit Reached')).toBe('rate_limited');
  });
});

describe('status fallback', () => {
  it('maps 402 Payment Required to quota_exceeded', () => {
    expect(providerErrorCodeForStatus(402)).toBe('quota_exceeded');
  });
});
