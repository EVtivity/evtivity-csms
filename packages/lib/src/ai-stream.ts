// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The AI assistant stream protocol: the Server-Sent Events a conversation
 * turn sends from the API to the CSMS. Browser-safe, so both the server writer
 * and the frontends import it via `@evtivity/lib/ai-stream`.
 *
 * Wire format, one frame per event:
 *
 *   event: <type>\n
 *   data: <JSON of the whole event, including "type">\n
 *   \n
 *
 * A heartbeat is an SSE comment frame (`: heartbeat`), sent every
 * `AI_STREAM_HEARTBEAT_INTERVAL_MS` so proxies with an idle timeout (ALB 60 s)
 * keep the connection open. Parsers skip it.
 *
 * The client posts with `fetch` and reads the body with `readAiStream`
 * (EventSource cannot POST).
 */

import { z } from 'zod';

/** Bumped when an event changes shape in a way old clients cannot read. */
export const AI_STREAM_PROTOCOL_VERSION = 1;

/** Below the 60 s idle timeout of the AWS ALB and of common proxies. */
export const AI_STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

/** An SSE comment frame. Parsers ignore it. */
export const AI_STREAM_HEARTBEAT_FRAME = ': heartbeat\n\n';

/** Response headers of a stream (the same set as `/v1/events`). */
export const AI_STREAM_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
});

const id = z.string().min(1).max(200);
const nonNegativeInt = z.number().int().nonnegative();
/** Machine-readable API error code (the `code` field of API errors). */
const errorCode = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/)
  .max(100);

export const AI_TOOL_STEP_STATUSES = [
  'running',
  'ok',
  'refused',
  'error',
  'pending_confirmation',
  'confirmed',
  'rejected',
] as const;
export type AiToolStepStatus = (typeof AI_TOOL_STEP_STATUSES)[number];

/**
 * Why the server refused a tool call (a `refused` step). The client shows a
 * localized summary per reason; the model gets its own explanation.
 */
export const AI_TOOL_REFUSAL_REASONS = [
  /** The tool is not offered on this surface, or an argument may not be set. */
  'unavailable',
  /** The arguments do not match the operation schema or the allowed values. */
  'invalid_arguments',
  /** The turn reached `ai.maxToolCallsPerTurn`. */
  'limit_reached',
  /** A change already waits for confirmation in this turn. */
  'one_change_at_a_time',
  /** The tool policy changed between the proposal and the confirmation. */
  'no_longer_available',
  /** The OCPP command targets a station the user cannot see, or that does not exist. */
  'station_not_found',
  /** The OCPP command is for the other protocol version and has no equivalent on the station's. */
  'ocpp_version_mismatch',
] as const;
export type AiToolRefusalReason = (typeof AI_TOOL_REFUSAL_REASONS)[number];

/** Why a turn ended, as the client sees it. */
export const AI_TURN_FINISH_REASONS = [
  'end',
  'stopped',
  'max_tokens',
  'refusal',
  'context_exceeded',
  'confirmation_required',
  'error',
] as const;
export type AiTurnFinishReason = (typeof AI_TURN_FINISH_REASONS)[number];

export const aiStreamUsageSchema = z
  .object({
    inputTokens: nonNegativeInt,
    cachedReadTokens: nonNegativeInt,
    cacheWriteTokens: nonNegativeInt,
    outputTokens: nonNegativeInt,
    reasoningTokens: nonNegativeInt,
    /**
     * Cost in micro-units of the company currency (`aiCostInCompanyCurrencyMicros`).
     * Omitted when the model has no prices or the company currency is not the
     * providers' USD (no exchange rate is kept): show tokens only.
     */
    costMicros: nonNegativeInt.optional(),
  })
  .strict();
export type AiStreamUsage = z.infer<typeof aiStreamUsageSchema>;

export const aiStreamEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('message_start'),
      protocolVersion: z.literal(AI_STREAM_PROTOCOL_VERSION),
      conversationId: id,
      messageId: id,
      provider: z.string().min(1).max(50),
      model: z.string().min(1).max(200),
    })
    .strict(),
  z.object({ type: z.literal('text_delta'), text: z.string() }).strict(),
  z
    .object({
      type: z.literal('tool_step'),
      toolCallId: id,
      name: z.string().min(1).max(200),
      status: z.enum(AI_TOOL_STEP_STATUSES),
      /** Redacted, human-readable summary of the call or its result. */
      summary: z.string().max(2000).optional(),
      /** Set on a `refused` step. */
      reason: z.enum(AI_TOOL_REFUSAL_REASONS).optional(),
      durationMs: nonNegativeInt.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('confirmation_required'),
      actionId: id,
      toolCallId: id,
      /** Tool name of the proposed call (the operation the user confirms). */
      name: z.string().min(1).max(200),
      /** Single-use secret the confirm and reject requests send back. */
      nonce: z.string().min(16).max(200),
      method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
      path: z.string().min(1).max(2000),
      summary: z.string().min(1).max(2000),
      /** Redacted arguments, shown on the confirm card. */
      arguments: z.record(z.unknown()),
      expiresAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      type: z.literal('citation'),
      id,
      title: z.string().min(1).max(500),
      url: z
        .string()
        .url()
        .refine((u) => u.startsWith('https://'), 'citation URLs are https'),
      anchor: z.string().max(200).optional(),
    })
    .strict(),
  z.object({ type: z.literal('usage'), usage: aiStreamUsageSchema }).strict(),
  z
    .object({
      type: z.literal('error'),
      code: errorCode,
      /** Safe for display: never provider bodies, headers or keys. */
      message: z.string().max(1000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('done'),
      messageId: id,
      finish: z.enum(AI_TURN_FINISH_REASONS),
    })
    .strict(),
]);

export type AiStreamEvent = z.infer<typeof aiStreamEventSchema>;
export type AiStreamEventType = AiStreamEvent['type'];
export type AiStreamEventOf<T extends AiStreamEventType> = Extract<AiStreamEvent, { type: T }>;

export const AI_STREAM_EVENT_TYPES = [
  'message_start',
  'text_delta',
  'tool_step',
  'confirmation_required',
  'citation',
  'usage',
  'error',
  'done',
] as const satisfies readonly AiStreamEventType[];

/** A frame that is not valid protocol: bad JSON, unknown type, or wrong shape. */
export class AiStreamProtocolError extends Error {
  constructor(
    message: string,
    readonly frame: string,
  ) {
    super(message);
    this.name = 'AiStreamProtocolError';
  }
}

/**
 * Serializes one event into an SSE frame. Validates first, so the server can
 * never send an event the clients cannot parse.
 */
export function formatAiStreamEvent(event: AiStreamEvent): string {
  const parsed = aiStreamEventSchema.parse(event);
  // JSON.stringify never emits a raw newline, so the data fits on one line.
  return `event: ${parsed.type}\ndata: ${JSON.stringify(parsed)}\n\n`;
}

function decodeFrame(eventName: string | null, dataLines: string[], raw: string): AiStreamEvent {
  let json: unknown;
  try {
    json = JSON.parse(dataLines.join('\n'));
  } catch (err) {
    throw new AiStreamProtocolError(
      `invalid JSON in stream frame: ${err instanceof Error ? err.message : String(err)}`,
      raw,
    );
  }
  const result = aiStreamEventSchema.safeParse(json);
  if (!result.success) {
    throw new AiStreamProtocolError(
      `invalid stream event: ${result.error.issues[0]?.message ?? 'unknown'}`,
      raw,
    );
  }
  if (eventName != null && eventName !== result.data.type) {
    throw new AiStreamProtocolError(
      `event name "${eventName}" does not match type "${result.data.type}"`,
      raw,
    );
  }
  return result.data;
}

export interface AiStreamParser {
  /** Feeds decoded text; returns the events completed by it. */
  feed(chunk: string): AiStreamEvent[];
  /** Flushes a final frame that was not followed by a blank line. */
  end(): AiStreamEvent[];
}

/**
 * Incremental SSE parser (WHATWG event stream rules: LF, CRLF or CR line
 * ends, comment lines, multi-line data). Chunks may split anywhere. Throws
 * `AiStreamProtocolError` on an invalid frame.
 */
export function createAiStreamParser(): AiStreamParser {
  let buffer = '';
  let eventName: string | null = null;
  let dataLines: string[] = [];
  let rawLines: string[] = [];
  let pendingCr = false;

  function dispatch(out: AiStreamEvent[]): void {
    if (dataLines.length > 0) {
      out.push(decodeFrame(eventName, dataLines, rawLines.join('\n')));
    }
    eventName = null;
    dataLines = [];
    rawLines = [];
  }

  function processLine(line: string, out: AiStreamEvent[]): void {
    if (line === '') {
      dispatch(out);
      return;
    }
    if (line.startsWith(':')) return;
    rawLines.push(line);
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    // `id` and `retry` carry nothing for this protocol; unknown fields are ignored per spec.
  }

  return {
    feed(chunk: string): AiStreamEvent[] {
      const out: AiStreamEvent[] = [];
      let text = chunk;
      // A CR at the end of the previous chunk may be the first half of CRLF.
      if (pendingCr && text.startsWith('\n')) text = text.slice(1);
      pendingCr = false;
      buffer += text;
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch !== '\n' && ch !== '\r') continue;
        processLine(buffer.slice(start, i), out);
        if (ch === '\r') {
          if (i + 1 < buffer.length) {
            if (buffer[i + 1] === '\n') i++;
          } else {
            pendingCr = true;
          }
        }
        start = i + 1;
      }
      buffer = buffer.slice(start);
      return out;
    },
    end(): AiStreamEvent[] {
      const out: AiStreamEvent[] = [];
      if (buffer !== '') processLine(buffer, out);
      buffer = '';
      dispatch(out);
      return out;
    },
  };
}

/**
 * Reads a `fetch` response body as stream events. Aborting the fetch ends
 * the iteration with the fetch's AbortError.
 */
export async function* readAiStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<AiStreamEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createAiStreamParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* parser.feed(decoder.decode(value, { stream: true }));
    }
    yield* parser.feed(decoder.decode());
    yield* parser.end();
  } finally {
    reader.releaseLock();
  }
}
