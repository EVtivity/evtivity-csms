// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Contract-suite harness. Every adapter passes the same contract cases
 * (TC-AI-P-*, lane L1), run against its recorded wire fixtures on the mock
 * provider server, or live against the real endpoint when a key is given.
 *
 * Test-only and runner-agnostic (no vitest import): a contract test file
 * loops over the cases and registers each with its runner:
 *
 *   for (const c of CONTRACT_CASES) {
 *     it(contractTestName(c), () => runContractCase(anthropicTarget, c));
 *   }
 *
 * A live file passes `{ live: { apiKey } }`, reading the key from the
 * environment itself; the harness never reads environment variables.
 *
 * `createScriptedAdapter` is a provider-free `AiAdapter` for engine and route
 * tests that do not need the wire format.
 */

import { collectAiStream, AiStreamAccumulator } from '../core/collect.js';
import { resolveModelCapabilities } from '../core/model-registry.js';
import type {
  AiAdapter,
  AiAdapterOptions,
  AiRequest,
  AiResult,
  AiStreamEvent,
  ModelCapabilities,
  ProviderId,
} from '../core/types.js';
import { startMockProviderServer } from './mock-provider-server.js';
import type { MockProviderServer, RecordedRequest, WireFixture } from './mock-provider-server.js';

/** Key the adapters get in fixture mode. Shaped like a key so redaction tests can find it. */
export const CONTRACT_TEST_API_KEY = 'sk-contract-test-0123456789abcdef';

export interface ContractTarget {
  provider: ProviderId;
  /** Model the cases run against. */
  model: string;
  createAdapter(options: AiAdapterOptions): AiAdapter;
  /** Recorded responses by name; a list is served in order (one per request). */
  fixtures: Readonly<Record<string, WireFixture | readonly WireFixture[]>>;
}

export type ContractMode = 'fixture' | 'live';

export interface ContractRunOptions {
  /** Abort after this many events were received. */
  abortAfterEvents?: number;
  /** Abort this long after the stream started. */
  abortAfterMs?: number;
  /** Abort and fail the run when the stream has not ended by then (default 10 s). */
  timeoutMs?: number;
}

export interface ContractRun {
  events: AiStreamEvent[];
  result: AiResult;
  /** What the stream threw, or null. */
  error: unknown;
  /** The run aborted the stream (by option or timeout). */
  aborted: boolean;
  timedOut: boolean;
  /** Milliseconds from the abort to the end of the stream; null without an abort. */
  abortToEndMs: number | null;
}

export interface ContractContext {
  readonly target: ContractTarget;
  readonly mode: ContractMode;
  readonly adapter: AiAdapter;
  readonly capabilities: ModelCapabilities;
  /** The mock server in fixture mode; null live. */
  readonly server: MockProviderServer | null;
  /** A minimal valid request for the target model, with overrides. */
  request(overrides?: Partial<AiRequest>): AiRequest;
  run(req: AiRequest, options?: ContractRunOptions): Promise<ContractRun>;
  complete(req: AiRequest): Promise<AiResult>;
  /** Requests the adapter sent (fixture mode only). */
  requests(): readonly RecordedRequest[];
}

export interface ContractCase {
  /** Case id without the `TC-AI-` prefix, such as `P-01`. */
  id: string;
  title: string;
  /** Fixture names queued before the case runs (fixture mode). */
  fixtures?: readonly string[];
  /** Also runs in live mode (it must not depend on fixture content). */
  live?: boolean;
  /** Runs only when the target model has these capabilities. */
  requires?: (caps: ModelCapabilities) => boolean;
  run(ctx: ContractContext): Promise<void>;
}

export interface ContractCaseOptions {
  live?: { apiKey: string; baseUrl?: string };
}

/** Test name that starts with the case id, so `grep -rn 'TC-AI-'` finds it. */
export function contractTestName(c: ContractCase): string {
  return `TC-AI-${c.id} ${c.title}`;
}

/** Whether `runContractCase` would run the case (vs. skip) for this target and mode. */
export function contractCaseApplies(
  target: ContractTarget,
  c: ContractCase,
  options: ContractCaseOptions = {},
): boolean {
  if (options.live !== undefined && c.live !== true) return false;
  if (
    c.requires !== undefined &&
    !c.requires(resolveModelCapabilities(target.provider, target.model))
  )
    return false;
  return true;
}

function baseRequest(model: string, overrides: Partial<AiRequest> = {}): AiRequest {
  return {
    model,
    system: [{ text: 'You are a contract test. Answer briefly.', cacheable: true }],
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'Say hello.' }] }],
    tools: [],
    effort: 'low',
    maxOutputTokens: 256,
    ...overrides,
  };
}

/**
 * Streams `req` through `adapter` and records every event. Never throws for
 * a stream failure: the error goes into the run so the case can assert on it.
 */
export async function runAdapterStream(
  adapter: AiAdapter,
  req: AiRequest,
  options: ContractRunOptions = {},
): Promise<ContractRun> {
  const controller = new AbortController();
  const acc = new AiStreamAccumulator();
  const events: AiStreamEvent[] = [];
  // Assigned from timers and the loop; an object keeps TS from narrowing it to null.
  const state: { abortedAt: number | null; timedOut: boolean } = {
    abortedAt: null,
    timedOut: false,
  };
  let error: unknown = null;

  const abort = (): void => {
    if (state.abortedAt === null) {
      state.abortedAt = Date.now();
      controller.abort();
    }
  };
  const timers: ReturnType<typeof setTimeout>[] = [];
  if (options.abortAfterMs !== undefined) timers.push(setTimeout(abort, options.abortAfterMs));
  timers.push(
    setTimeout(() => {
      state.timedOut = true;
      abort();
    }, options.timeoutMs ?? 10_000),
  );

  try {
    for await (const event of adapter.stream(req, controller.signal)) {
      events.push(event);
      acc.push(event);
      if (options.abortAfterEvents !== undefined && events.length >= options.abortAfterEvents) {
        abort();
      }
    }
  } catch (err) {
    error = err;
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }

  return {
    events,
    result: acc.result(),
    error,
    aborted: state.abortedAt !== null,
    timedOut: state.timedOut,
    abortToEndMs: state.abortedAt === null ? null : Date.now() - state.abortedAt,
  };
}

/**
 * Checks the event-order rules every adapter stream follows. Returns the
 * violations (empty when well formed).
 */
export function streamProblems(events: readonly AiStreamEvent[]): string[] {
  const problems: string[] = [];
  const started = new Map<string, string>();
  const done = new Set<string>();
  const finishes = events.filter((e) => e.type === 'finish');
  if (finishes.length !== 1)
    problems.push(`expected exactly one finish event, got ${String(finishes.length)}`);
  if (events.length > 0 && events.at(-1)?.type !== 'finish')
    problems.push('finish is not the last event');

  for (const [i, e] of events.entries()) {
    switch (e.type) {
      case 'tool_call_start':
        if (started.has(e.id)) problems.push(`#${String(i)}: tool call ${e.id} started twice`);
        started.set(e.id, e.name);
        break;
      case 'tool_call_delta':
        if (!started.has(e.id))
          problems.push(`#${String(i)}: delta for tool call ${e.id} before its start`);
        if (done.has(e.id))
          problems.push(`#${String(i)}: delta for tool call ${e.id} after its end`);
        break;
      case 'tool_call_done':
      case 'tool_call_error':
        if (done.has(e.id)) problems.push(`#${String(i)}: tool call ${e.id} ended twice`);
        if (started.has(e.id) && started.get(e.id) !== e.name)
          problems.push(`#${String(i)}: tool call ${e.id} changed name`);
        done.add(e.id);
        break;
      case 'usage':
        for (const [k, v] of Object.entries(e.usage) as [string, number][]) {
          if (!Number.isInteger(v) || v < 0)
            problems.push(`#${String(i)}: usage.${k} is ${String(v)}`);
        }
        break;
      case 'text_delta':
      case 'citation':
      case 'finish':
        break;
    }
  }
  for (const id of started.keys()) {
    if (!done.has(id)) problems.push(`tool call ${id} started but never ended`);
  }
  return problems;
}

/** Sets up the mock server (fixture mode) or the live endpoint, runs `fn`, and cleans up. */
export async function withContractContext(
  target: ContractTarget,
  fixtureNames: readonly string[],
  options: ContractCaseOptions,
  fn: (ctx: ContractContext) => Promise<void>,
): Promise<void> {
  const live = options.live;
  const server = live === undefined ? await startMockProviderServer() : null;
  try {
    if (server !== null) {
      for (const name of fixtureNames) {
        const fixture = target.fixtures[name];
        if (fixture === undefined) {
          throw new Error(`${target.provider}: no contract fixture named "${name}"`);
        }
        const list: readonly WireFixture[] = Array.isArray(fixture)
          ? (fixture as readonly WireFixture[])
          : [fixture as WireFixture];
        server.enqueue(...list);
      }
    }
    const adapterOptions: AiAdapterOptions =
      server !== null
        ? { apiKey: CONTRACT_TEST_API_KEY, baseUrl: server.baseUrl }
        : live?.baseUrl !== undefined
          ? { apiKey: live.apiKey, baseUrl: live.baseUrl }
          : { apiKey: live?.apiKey ?? '' };
    const adapter = target.createAdapter(adapterOptions);
    const ctx: ContractContext = {
      target,
      mode: server !== null ? 'fixture' : 'live',
      adapter,
      capabilities: adapter.capabilities(target.model),
      server,
      request: (overrides) => baseRequest(target.model, overrides),
      run: (req, runOptions) => runAdapterStream(adapter, req, runOptions),
      complete: (req) => adapter.complete(req, new AbortController().signal),
      requests() {
        if (server === null) throw new Error('requests() is not available in live mode');
        return server.requests;
      },
    };
    await fn(ctx);
  } finally {
    await server?.close();
  }
}

/** Runs one contract case for a target. A case that does not apply resolves without running. */
export async function runContractCase(
  target: ContractTarget,
  c: ContractCase,
  options: ContractCaseOptions = {},
): Promise<void> {
  if (!contractCaseApplies(target, c, options)) return;
  await withContractContext(target, c.fixtures ?? [], options, (ctx) => c.run(ctx));
}

// ---------------------------------------------------------------------------
// Scripted adapter (no HTTP)
// ---------------------------------------------------------------------------

export interface ScriptedStep {
  events: readonly AiStreamEvent[];
  /** Wait this long before each event. */
  delayMs?: number;
  /** Throw this after the events (provider failure mid-stream). */
  error?: Error;
}

export interface ScriptedAdapter extends AiAdapter {
  /** Requests received, in order. */
  readonly calls: readonly AiRequest[];
  /** Calls whose signal was aborted before the step finished. */
  readonly abortedCalls: number;
}

/**
 * An adapter that answers call N with `steps[N]`. Honors the abort signal
 * between events and then ends with `finish: stopped`, as every real adapter
 * must. Throws when called more often than scripted.
 */
export function createScriptedAdapter(
  steps: readonly ScriptedStep[],
  options: { provider?: ProviderId; capabilities?: ModelCapabilities } = {},
): ScriptedAdapter {
  const provider = options.provider ?? 'anthropic';
  const calls: AiRequest[] = [];
  let abortedCalls = 0;

  const wait = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });

  const adapter: ScriptedAdapter = {
    provider,
    get calls() {
      return calls;
    },
    get abortedCalls() {
      return abortedCalls;
    },
    capabilities: (model) => options.capabilities ?? resolveModelCapabilities(provider, model),
    async *stream(req, signal) {
      const step = steps[calls.length];
      calls.push(req);
      if (step === undefined)
        throw new Error(`scripted adapter: no step for call ${String(calls.length)}`);
      for (const event of step.events) {
        if (step.delayMs !== undefined) await wait(step.delayMs, signal);
        if (signal.aborted) {
          abortedCalls++;
          yield { type: 'finish', reason: 'stopped' };
          return;
        }
        yield event;
      }
      if (step.error !== undefined) throw step.error;
    },
    complete(req, signal) {
      return collectAiStream(adapter.stream(req, signal));
    },
  };
  return adapter;
}
