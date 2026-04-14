// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { createAiProvider } from '../services/ai/provider-factory.js';
import { buildToolRequest } from '../services/ai/tools.js';
import { AnthropicProvider } from '../services/ai/anthropic-provider.js';
import { OpenAiProvider } from '../services/ai/openai-provider.js';
import { GeminiProvider } from '../services/ai/gemini-provider.js';

describe('createAiProvider', () => {
  it('returns AnthropicProvider for anthropic', () => {
    const provider = createAiProvider('anthropic', 'test-key');
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it('returns OpenAiProvider for openai', () => {
    const provider = createAiProvider('openai', 'test-key');
    expect(provider).toBeInstanceOf(OpenAiProvider);
  });

  it('returns GeminiProvider for gemini', () => {
    const provider = createAiProvider('gemini', 'test-key');
    expect(provider).toBeInstanceOf(GeminiProvider);
  });

  it('throws for unknown provider', () => {
    expect(() => createAiProvider('invalid', 'test-key')).toThrow('Unknown AI provider: invalid');
  });
});

describe('buildToolRequest', () => {
  it('returns correct method and url for list_dashboard_stats', () => {
    const result = buildToolRequest('list_dashboard_stats', {});
    expect(result.method).toBe('GET');
    expect(result.url).toBe('/v1/dashboard/stats');
    expect(result.query).toEqual({});
  });

  it('interpolates path params for get_station', () => {
    const result = buildToolRequest('get_station', { id: 'STATION-001' });
    expect(result.method).toBe('GET');
    expect(result.url).toBe('/v1/stations/STATION-001');
    expect(result.query).toEqual({});
  });

  it('separates query params for list_stations', () => {
    const result = buildToolRequest('list_stations', { page: 2, limit: 10 });
    expect(result.method).toBe('GET');
    expect(result.url).toBe('/v1/stations');
    expect(result.query).toEqual({ page: '2', limit: '10' });
  });

  it('handles mixed path and query params for get_session', () => {
    const result = buildToolRequest('get_session', { id: 'sess-123' });
    expect(result.method).toBe('GET');
    expect(result.url).toBe('/v1/sessions/sess-123');
    expect(result.query).toEqual({});
  });

  it('ignores undefined and null values in query params', () => {
    const result = buildToolRequest('list_stations', {
      page: 1,
      limit: undefined,
      search: null,
    });
    expect(result.query).toEqual({ page: '1' });
  });

  it('throws for unknown tool name', () => {
    expect(() => buildToolRequest('nonexistent_tool', {})).toThrow(
      'Unknown tool: nonexistent_tool',
    );
  });

  it('encodes special characters in path params', () => {
    const result = buildToolRequest('get_station', { id: 'STATION/001' });
    expect(result.url).toBe('/v1/stations/STATION%2F001');
  });
});
