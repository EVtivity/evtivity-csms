// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Wraps an adapter so the caller learns how each model call ended, without
 * changing what the call returns or throws. The services package uses it to
 * keep the provider quota alert state: a `quota_exceeded` failure sets it, a
 * completed call clears it. An observer that throws or rejects is ignored,
 * so a broken observer never breaks a model call.
 */

import { collectAiStream } from './collect.js';
import { isAiProviderError } from './errors.js';
import type { AiProviderError } from './errors.js';
import type { AiAdapter, AiStreamEvent } from './types.js';

export interface AiCallObserver {
  /** The call failed with a provider error (abort excluded). */
  onProviderError?(err: AiProviderError): void | Promise<void>;
  /** The call completed: the stream ended without an error and was not aborted. */
  onSuccess?(): void | Promise<void>;
}

function notify(fn: (() => void | Promise<void>) | undefined): void {
  if (fn === undefined) return;
  try {
    const out = fn();
    if (out instanceof Promise) {
      // fail-open: an observer failure never reaches the model call.
      out.catch(() => undefined);
    }
  } catch {
    // fail-open: an observer failure never reaches the model call.
  }
}

/**
 * A pass-through, not a model call site: the caller's request (already
 * redacted at its call) goes to `inner` unchanged.
 */
export function observeAdapter(inner: AiAdapter, observer: AiCallObserver): AiAdapter {
  const wrapped: AiAdapter = {
    provider: inner.provider,
    capabilities: (model) => inner.capabilities(model),
    async *stream(req, signal): AsyncIterable<AiStreamEvent> {
      try {
        yield* inner.stream(req, signal);
      } catch (err) {
        if (isAiProviderError(err) && err.code !== 'aborted') {
          notify(observer.onProviderError?.bind(observer, err));
        }
        throw err;
      }
      if (!signal.aborted) notify(observer.onSuccess?.bind(observer));
    },
    complete(req, signal) {
      return collectAiStream(wrapped.stream(req, signal));
    },
  };
  return wrapped;
}
