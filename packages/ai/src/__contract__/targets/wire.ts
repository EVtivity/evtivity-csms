// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** Builders for the recorded wire fixtures of the contract targets. */

import { sseChunks } from '../mock-provider-server.js';
import type { WireChunk, WireFixture } from '../mock-provider-server.js';
import { CONTRACT_TEST_API_KEY } from '../harness.js';

const SSE_HEADERS = { 'content-type': 'text/event-stream' } as const;

/** An SSE response; `named` writes an `event:` line from each payload's `type`. */
export function sseFixture(
  payloads: readonly unknown[],
  options: { named?: boolean; done?: boolean } = {},
): WireFixture {
  const chunks: WireChunk[] = sseChunks(payloads, {
    ...(options.named === true ? { event: (p) => (p as { type?: string }).type } : {}),
  });
  if (options.done === true) chunks.push({ data: 'data: [DONE]\n\n' });
  return { headers: SSE_HEADERS, body: chunks };
}

/**
 * An SSE response that sends `head` at once, then each of `slow` after a
 * delay, and stays open (abort tests).
 */
export function slowSseFixture(
  head: readonly unknown[],
  slow: readonly unknown[],
  options: { named?: boolean } = {},
): WireFixture {
  const event =
    options.named === true ? { event: (p: unknown) => (p as { type?: string }).type } : {};
  return {
    headers: SSE_HEADERS,
    body: [...sseChunks(head, event), ...sseChunks(slow, { ...event, delayMs: 300 })],
    hang: true,
  };
}

export function jsonErrorFixture(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): WireFixture {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

/** Text a provider might echo in an auth error; the adapter must strip it. */
export const LEAKY_AUTH_TEXT = `Invalid credentials: Authorization: Bearer ${CONTRACT_TEST_API_KEY}`;

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const SAMPLING_KEYS = ['temperature', 'top_p', 'top_k', 'topP', 'topK'];

/** Sampling keys present at the top of the body or in `config` / `generationConfig`. */
export function samplingKeys(body: Record<string, unknown>): string[] {
  const scopes = [body, asRecord(body.config), asRecord(body.generationConfig)];
  return SAMPLING_KEYS.filter((k) => scopes.some((s) => k in s));
}
