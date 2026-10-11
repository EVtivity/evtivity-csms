// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Shared fixtures of the AI data handling tests (TC-AI-AD, table in
 * `data-handling.md` next to this file): seeded secrets and personal
 * data, a provider that records the HTTP request body (the Anthropic adapter
 * against the mock provider server), and the leak check every surface test
 * runs on that body. Test code only.
 */

import { createAnthropicAdapter } from '../providers/anthropic/adapter.js';
import type { AiAdapter } from '../core/types.js';
import type { RedactionSurface } from '../redact.js';
import { sseChunks, startMockProviderServer } from './mock-provider-server.js';
import type { WireFixture } from './mock-provider-server.js';

/** Values that must never reach a provider in clear, on any surface. */
export const SEEDED_SECRETS = {
  /** A `*Enc` setting value (ciphertext) under a secret-shaped name. */
  settingEnc: 'v1:SEEDCIPHERTEXTabcdef0123456789',
  /** A provider API key. */
  apiKey: 'sk-ant-api03-SEEDAPIKEYabcdef0123456789',
  /** A stored password hash. */
  passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$SEEDSALT$SEEDHASHVALUE',
  /** A Stripe secret key inside free text. */
  stripeKey: 'sk_live_SEEDSTRIPE0123456789',
  /** A station Basic Auth password in a logged 2.1 SetVariables call. */
  stationPassword: 'SeedStationPass1234',
  /** The same kind of password as a 1.6 AuthorizationKey (hex). */
  authorizationKeyHex: '5365656453746174696F6E50617373',
} as const;

/** Payment data: sent only as the last 4 characters. */
export const SEEDED_PAYMENT = {
  /** A test Visa number without separators. */
  card: '4242424242424242',
  /** A test card number written in groups. */
  groupedCard: '4000 0566 5566 5556',
  iban: 'DE89370400440532013000',
} as const;

/** Personal data: masked or hashed on support and driver, sent as is on chatbot. */
export const SEEDED_PERSONAL = {
  email: 'jane.seed@example.com',
  phone: '+49 151 23456789',
  idToken: 'SEEDTOKEN0042',
  idTag: 'SEEDTAG7788',
} as const;

/** A tool result or evidence record holding every seeded value in its usual field. */
export function seededRecord(): Record<string, unknown> {
  return {
    id: 'drv_000000000001',
    firstName: 'Jane',
    email: SEEDED_PERSONAL.email,
    phone: SEEDED_PERSONAL.phone,
    passwordHash: SEEDED_SECRETS.passwordHash,
    token: { id: 'dtk_1', idToken: SEEDED_PERSONAL.idToken, tokenType: 'ISO14443' },
    settings: [{ key: 'smtp.passwordEnc', value: SEEDED_SECRETS.settingEnc }],
    provider: { apiKey: SEEDED_SECRETS.apiKey },
    payment: { cardNumber: SEEDED_PAYMENT.card, iban: SEEDED_PAYMENT.iban },
    note: `Paid with ${SEEDED_PAYMENT.groupedCard}, key ${SEEDED_SECRETS.stripeKey}`,
    ocppLog: [
      {
        action: 'SetVariables',
        payload: {
          setVariableData: [
            {
              component: { name: 'SecurityCtrlr' },
              variable: { name: 'BasicAuthPassword' },
              attributeValue: SEEDED_SECRETS.stationPassword,
            },
          ],
        },
      },
      {
        action: 'ChangeConfiguration',
        payload: { key: 'AuthorizationKey', value: SEEDED_SECRETS.authorizationKeyHex },
      },
      { action: 'Authorize', payload: { idTag: SEEDED_PERSONAL.idTag } },
    ],
    transactionId: '4111111111111111',
  };
}

/** Free text (a typed message, a text attachment, a driver message) holding the seeded values. */
export function seededText(): string {
  return [
    `My key is ${SEEDED_SECRETS.apiKey} and the Stripe key ${SEEDED_SECRETS.stripeKey}.`,
    `Card ${SEEDED_PAYMENT.card}, also ${SEEDED_PAYMENT.groupedCard}, IBAN ${SEEDED_PAYMENT.iban}.`,
    `Reach me at ${SEEDED_PERSONAL.email} or ${SEEDED_PERSONAL.phone}.`,
  ].join('\n');
}

function digits(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * The seeded values found in clear in `body` that the redaction level must
 * mask: secrets and full card numbers and IBANs everywhere, and on support
 * and driver the email address, the phone number and the token ids.
 */
export function findLeaks(body: string, level: RedactionSurface): string[] {
  const found: string[] = [];
  for (const [name, value] of Object.entries(SEEDED_SECRETS)) {
    if (body.includes(value)) found.push(name);
  }
  if (body.includes(SEEDED_PAYMENT.card)) found.push('card');
  if (
    body.includes(SEEDED_PAYMENT.groupedCard) ||
    body.includes(digits(SEEDED_PAYMENT.groupedCard))
  )
    found.push('groupedCard');
  if (body.includes(SEEDED_PAYMENT.iban)) found.push('iban');
  if (level !== 'chatbot') {
    for (const [name, value] of Object.entries(SEEDED_PERSONAL)) {
      if (body.includes(value)) found.push(name);
    }
    if (body.includes(digits(SEEDED_PERSONAL.phone))) found.push('phoneDigits');
  }
  return found;
}

// ---------------------------------------------------------------------------
// Recording provider
// ---------------------------------------------------------------------------

const MODEL = 'claude-sonnet-5-5';

function messageStart(): unknown {
  return {
    type: 'message_start',
    message: {
      id: 'msg_data_handling',
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 1 },
    },
  };
}

function sse(payloads: readonly unknown[]): WireFixture {
  return {
    headers: { 'content-type': 'text/event-stream' },
    body: sseChunks(payloads, { event: (p) => (p as { type?: string }).type }),
  };
}

/** A recorded answer: plain text, or one tool call. */
export type RecordedReply = { text: string } | { toolCall: { name: string; args: unknown } };

function replyFixture(reply: RecordedReply, index: number): WireFixture {
  const end = (reason: string): unknown[] => [
    {
      type: 'message_delta',
      delta: { stop_reason: reason, stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: 'message_stop' },
  ];
  if ('text' in reply) {
    return sse([
      messageStart(),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.text } },
      { type: 'content_block_stop', index: 0 },
      ...end('end_turn'),
    ]);
  }
  return sse([
    messageStart(),
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: `toolu_${String(index)}`,
        name: reply.toolCall.name,
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.toolCall.args) },
    },
    { type: 'content_block_stop', index: 0 },
    ...end('tool_use'),
  ]);
}

export interface RecordingProvider {
  /** A real Anthropic adapter whose requests go to the recording server. */
  adapter: AiAdapter;
  model: string;
  /** The HTTP request bodies, in order. */
  bodies(): string[];
  close(): Promise<void>;
}

/**
 * Starts a provider that records every HTTP request body. Call N is answered
 * with `replies[N]`, later calls with `fallback` (default: a short text).
 */
export async function startRecordingProvider(
  replies: readonly RecordedReply[] = [],
  fallback: RecordedReply = { text: 'ok' },
): Promise<RecordingProvider> {
  const server = await startMockProviderServer();
  let calls = 0;
  server.setHandler(() => {
    const reply = replies[calls] ?? fallback;
    calls++;
    return replyFixture(reply, calls);
  });
  return {
    adapter: createAnthropicAdapter({ apiKey: 'sk-data-handling-test', baseUrl: server.baseUrl }),
    model: MODEL,
    bodies: () => server.requests.map((r) => r.body),
    close: () => server.close(),
  };
}
