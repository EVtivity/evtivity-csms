// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Helpers every adapter shares. No provider SDK import here: each adapter
 * folder (`providers/<name>/`) is the only place its SDK is loaded.
 */

import { AiProviderError, providerErrorCodeForStatus } from '../core/errors.js';
import type { AiProviderErrorCode } from '../core/errors.js';
import { findUnsupportedParts } from '../core/messages.js';
import type {
  AiAttachmentContent,
  AiDocumentPart,
  AiImagePart,
  AiRequest,
  AiStreamEvent,
  AiUsage,
  Effort,
  ModelCapabilities,
  ProviderId,
} from '../core/types.js';

/** Output budget when the request sets none; it covers reasoning plus text. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

export function maxOutputTokens(req: AiRequest, caps: ModelCapabilities): number {
  const wanted = req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.max(1, Math.min(wanted, caps.maxOutputTokens));
}

/** The effort to send, or undefined when the model takes no effort parameter. */
export function effortFor(req: AiRequest, caps: ModelCapabilities): Effort | undefined {
  return caps.effort.includes(req.effort) ? req.effort : undefined;
}

/**
 * Refuses a request with parts the model cannot take, before any provider
 * call. The engine checks first (`AI_ATTACHMENT_UNSUPPORTED`); this is the
 * second layer, so an adapter never sends an image to a text-only model.
 */
export function assertPartsSupported(
  provider: ProviderId,
  req: AiRequest,
  caps: ModelCapabilities,
): void {
  const unsupported = findUnsupportedParts(req, caps);
  const first = unsupported[0];
  if (first !== undefined) {
    throw new AiProviderError({
      code: 'invalid_request',
      provider,
      message: `Model ${req.model} does not accept this content (${first.reason})`,
    });
  }
}

export async function resolveAttachment(
  provider: ProviderId,
  req: AiRequest,
  part: AiImagePart | AiDocumentPart,
): Promise<AiAttachmentContent> {
  if (req.resolveAttachment === undefined) {
    throw new AiProviderError({
      code: 'invalid_request',
      provider,
      message: `No attachment resolver for attachment ${part.attachmentId}`,
    });
  }
  return req.resolveAttachment(part.attachmentId);
}

export function toBase64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
}

export function dataUrl(mime: string, data: Uint8Array): string {
  return `data:${mime};base64,${toBase64(data)}`;
}

/**
 * A text document as one text block. The content is untrusted: it is fenced
 * and any closing fence inside it is neutralized, so it cannot end the block
 * early and pose as instructions.
 */
export function textDocumentBlock(name: string | undefined, data: Uint8Array): string {
  const text = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    .toString('utf8')
    .replaceAll('</untrusted_document>', '</untrusted_document_>');
  const label = (name ?? 'document').replace(/["<>\r\n]/g, '_');
  return `<untrusted_document name="${label}">\n${text}\n</untrusted_document>`;
}

export type ParsedArguments =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/** Parses streamed tool arguments. Empty input is `{}`; anything but a JSON object fails. */
export function parseToolArguments(raw: string): ParsedArguments {
  if (raw.trim() === '') return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `Tool arguments are not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Tool arguments are not a JSON object' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** The `tool_call_done` or `tool_call_error` event for a finished tool call. */
export function toolCallEnd(id: string, name: string, rawArguments: string): AiStreamEvent {
  const parsed = parseToolArguments(rawArguments);
  return parsed.ok
    ? { type: 'tool_call_done', id, name, arguments: parsed.value }
    : { type: 'tool_call_error', id, name, rawArguments, message: parsed.error };
}

/** Closes a tool call the stream never finished (abort or truncation). */
export function toolCallCut(id: string, name: string, rawArguments: string): AiStreamEvent {
  return {
    type: 'tool_call_error',
    id,
    name,
    rawArguments,
    message: 'The response ended before the tool arguments were complete',
  };
}

export function usage(values: Partial<AiUsage>): AiUsage {
  const n = (v: number | null | undefined): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
  return {
    inputTokens: n(values.inputTokens),
    cachedReadTokens: n(values.cachedReadTokens),
    cacheWriteTokens: n(values.cacheWriteTokens),
    outputTokens: n(values.outputTokens),
    reasoningTokens: n(values.reasoningTokens),
  };
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (typeof headers === 'object' && headers !== null) {
    const value = (headers as Record<string, unknown>)[name];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

/** `retry-after` (seconds or HTTP date) or `retry-after-ms`, in milliseconds. */
export function retryAfterMs(headers: unknown): number | undefined {
  const ms = headerValue(headers, 'retry-after-ms');
  if (ms !== undefined && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const value = headerValue(headers, 'retry-after');
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

const CONTEXT_EXCEEDED_TEXT =
  /context[_ ](length|window)|prompt is too long|too many tokens|maximum context|input token count|exceeds the (maximum|context)/i;

/** Refines a status-based code with the provider's error text. */
export function errorCodeFor(
  status: number | undefined,
  text: string,
  overrides: Readonly<Record<string, AiProviderErrorCode>> = {},
): AiProviderErrorCode {
  for (const [needle, code] of Object.entries(overrides)) {
    if (text.includes(needle)) return code;
  }
  if (CONTEXT_EXCEEDED_TEXT.test(text)) return 'context_exceeded';
  return status === undefined ? 'unknown' : providerErrorCodeForStatus(status);
}

/**
 * Maps any failure thrown while calling a provider to an `AiProviderError`
 * with a sanitized message. `describe` reads the provider-specific error
 * shape (status, body text, headers).
 */
export function toProviderError(
  provider: ProviderId,
  err: unknown,
  apiKey: string,
  describe: (err: unknown) => { status?: number; text: string; headers?: unknown },
  overrides: Readonly<Record<string, AiProviderErrorCode>> = {},
): AiProviderError {
  if (err instanceof AiProviderError) return err;
  const { status, text, headers } = describe(err);
  const retry = retryAfterMs(headers);
  return new AiProviderError({
    code: errorCodeFor(status, text, overrides),
    provider,
    message: text === '' ? 'Provider request failed' : text,
    knownSecrets: [apiKey],
    ...(status !== undefined ? { status } : {}),
    ...(retry !== undefined ? { retryAfterMs: retry } : {}),
  });
}

/** The status and message of a typical SDK `APIError` (Anthropic, OpenAI). */
export function describeSdkError(err: unknown): {
  status?: number;
  text: string;
  headers?: unknown;
} {
  if (typeof err !== 'object' || err === null) return { text: String(err) };
  const e = err as { status?: unknown; message?: unknown; headers?: unknown; error?: unknown };
  const status = typeof e.status === 'number' ? e.status : undefined;
  const body = e.error !== undefined ? JSON.stringify(e.error) : '';
  const message = typeof e.message === 'string' ? e.message : '';
  const text = body !== '' && !message.includes(body) ? `${message} ${body}` : message;
  return { ...(status !== undefined ? { status } : {}), text, headers: e.headers };
}

/** True when the failure is the caller's abort (the stream then ends with `stopped`). */
export function isAbort(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'APIUserAbortError');
}
