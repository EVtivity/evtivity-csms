// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Provider-neutral AI types. Every adapter (`providers/<name>/`) maps these to
 * and from its provider's wire format; nothing outside an adapter sees a
 * provider SDK type or compares a provider name. Logic branches on
 * `ModelCapabilities`, never on `ProviderId`.
 */

export const PROVIDER_IDS = ['anthropic', 'openai', 'gemini', 'deepseek'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

/** One operator-facing reasoning effort level; each adapter maps it to its own parameter. */
export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value);
}

export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

export const TEXT_DOCUMENT_MIMES = [
  'text/plain',
  'text/csv',
  'application/json',
  'application/x-ndjson',
] as const;
export type TextDocumentMime = (typeof TEXT_DOCUMENT_MIMES)[number];

export type DocumentMime = 'application/pdf' | TextDocumentMime;

export interface VisionCapability {
  formats: readonly ImageMime[];
  /** Largest image the provider accepts, in bytes of the encoded file. */
  maxBytes: number;
  maxLongEdgePx: number;
  maxImages: number;
}

export interface PdfCapability {
  maxBytes: number;
  maxPages: number;
}

/** What one model accepts. Flags are per model, not per provider. */
export interface ModelCapabilities {
  streaming: true;
  tools: boolean;
  parallelToolCalls: boolean;
  /** Provider-side strict JSON schema enforcement of tool arguments. */
  strictTools: boolean;
  vision: false | VisionCapability;
  /** Text documents are sent as untrusted text blocks to every model. */
  documents: { pdf: false | PdfCapability; text: true };
  caching: 'explicit' | 'automatic' | 'none';
  structuredOutput: boolean;
  citations: 'native' | 'prompted';
  /** Effort levels the model accepts. Empty: the adapter sends no effort parameter. */
  effort: readonly Effort[];
  /** False: temperature, top_p and top_k are never sent. */
  samplingParams: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface AiTextPart {
  type: 'text';
  text: string;
}

/** Image bytes are fetched through `AiRequest.resolveAttachment`. */
export interface AiImagePart {
  type: 'image';
  attachmentId: string;
  mime: ImageMime;
}

export interface AiDocumentPart {
  type: 'document';
  attachmentId: string;
  mime: DocumentMime;
  /** Display name, untrusted. */
  name?: string;
}

export interface AiToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Output of a tool, already redacted. Always untrusted: adapters send it as
 * data, never as instructions.
 */
export interface AiToolResultPart {
  type: 'tool_result';
  toolCallId: string;
  name: string;
  /** Serialized result (JSON text or plain text). Adapters never parse it. */
  content: string;
  isError: boolean;
}

export type AiPart = AiTextPart | AiImagePart | AiDocumentPart | AiToolCallPart | AiToolResultPart;
export type AiPartType = AiPart['type'];

/**
 * Opaque provider state an assistant turn carries (thinking blocks with
 * signatures, encrypted reasoning items, `reasoning_content`, thought
 * signatures). Only the adapter that produced it reads it, and only when the
 * provider and model match the conversation's (see `stripForeignProviderState`).
 */
export interface AiProviderState {
  provider: ProviderId;
  model: string;
  opaque: unknown;
}

export type AiRole = 'user' | 'assistant' | 'tool';

export interface AiMessage {
  role: AiRole;
  parts: AiPart[];
  providerState?: AiProviderState;
}

export interface AiToolDefinition {
  name: string;
  description: string;
  /** JSON schema of the arguments object. */
  parameters: Record<string, unknown>;
  /** The schema is strict-compatible; the adapter enables strict mode when the model supports it. */
  strict: boolean;
}

export interface AiSystemBlock {
  text: string;
  /** Static across requests: the adapter may place a cache breakpoint after it. */
  cacheable: boolean;
}

export interface AiAttachmentContent {
  mime: ImageMime | DocumentMime;
  data: Uint8Array;
  name?: string;
}

export type AiAttachmentResolver = (attachmentId: string) => Promise<AiAttachmentContent>;

export interface AiRequest {
  model: string;
  system: AiSystemBlock[];
  messages: AiMessage[];
  tools: AiToolDefinition[];
  effort: Effort;
  /** Upper bound on output tokens; the adapter clamps it to the model maximum. */
  maxOutputTokens?: number;
  /** Stable key for provider-side prompt caching (hash of surface and tool set). */
  cacheKey?: string;
  /** Ask for a JSON object matching this schema (router, structured drafts). */
  responseSchema?: { name: string; schema: Record<string, unknown> };
  resolveAttachment?: AiAttachmentResolver;
}

// ---------------------------------------------------------------------------
// Stream events and results
// ---------------------------------------------------------------------------

export interface AiUsage {
  inputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export const AI_FINISH_REASONS = [
  'end',
  'tool_use',
  'max_tokens',
  'refusal',
  'context_exceeded',
  /** The caller aborted the stream; the result is partial. */
  'stopped',
] as const;
export type AiFinishReason = (typeof AI_FINISH_REASONS)[number];

export interface AiCitation {
  /** Passage id the model cited (validated by the engine). */
  passageId: string;
  citedText?: string;
}

export type AiStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; argumentsDelta: string }
  | { type: 'tool_call_done'; id: string; name: string; arguments: Record<string, unknown> }
  /** The model produced arguments that are not a JSON object; never a throw. */
  | { type: 'tool_call_error'; id: string; name: string; rawArguments: string; message: string }
  | { type: 'citation'; citation: AiCitation }
  /** Cumulative usage so far; the last one wins. */
  | { type: 'usage'; usage: AiUsage }
  | { type: 'finish'; reason: AiFinishReason; providerState?: AiProviderState };

export type AiStreamEventType = AiStreamEvent['type'];

export interface AiToolCallError {
  id: string;
  name: string;
  rawArguments: string;
  message: string;
}

export interface AiResult {
  text: string;
  toolCalls: AiToolCallPart[];
  toolCallErrors: AiToolCallError[];
  citations: AiCitation[];
  usage: AiUsage;
  finishReason: AiFinishReason;
  providerState?: AiProviderState;
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export interface AiAdapterOptions {
  apiKey: string;
  /** Empty or undefined: the provider's official endpoint. */
  baseUrl?: string;
  /** Test seam; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface AiAdapter {
  readonly provider: ProviderId;
  capabilities(model: string): ModelCapabilities;
  /**
   * Streams one model response. Must end with exactly one `finish` event,
   * including on abort (`stopped`). Throws `AiProviderError` for provider
   * failures before or during the stream.
   */
  stream(req: AiRequest, signal: AbortSignal): AsyncIterable<AiStreamEvent>;
  /** Built on `stream` with `collectAiStream`. */
  complete(req: AiRequest, signal: AbortSignal): Promise<AiResult>;
}

export type AiAdapterFactory = (options: AiAdapterOptions) => AiAdapter;
