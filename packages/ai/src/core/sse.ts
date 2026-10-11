// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Server side of the AI stream protocol (`@evtivity/lib/ai-stream`): writes
 * the SSE headers and frames, sends a heartbeat comment on an interval, and
 * aborts `signal` when the client goes away, so the engine can stop the
 * provider stream and keep the partial message.
 *
 * Routes call `reply.hijack()` and pass `reply.raw`. Writes after the stream
 * closed are dropped.
 *
 * Disconnects are detected on the response, not the request: since Node 16 an
 * `IncomingMessage` emits `close` once its body is consumed, which for a POST
 * happens before the turn starts.
 */

import type { ServerResponse } from 'node:http';
import {
  AI_STREAM_HEADERS,
  AI_STREAM_HEARTBEAT_FRAME,
  AI_STREAM_HEARTBEAT_INTERVAL_MS,
  formatAiStreamEvent,
} from '@evtivity/lib/ai-stream';
import type { AiStreamEvent } from '@evtivity/lib/ai-stream';

export interface AiEventStreamOptions {
  heartbeatIntervalMs?: number;
  /** Extra headers (CORS and the like) merged over the protocol headers. */
  headers?: Record<string, string | string[]>;
}

export interface AiEventStream {
  /** Aborted when the client disconnects (or `close` is called). */
  readonly signal: AbortSignal;
  readonly closed: boolean;
  send(event: AiStreamEvent): boolean;
  /** Ends the response. Idempotent. */
  close(): void;
}

export function openAiEventStream(
  res: ServerResponse,
  options: AiEventStreamOptions = {},
): AiEventStream {
  const controller = new AbortController();
  let closed = false;

  res.writeHead(200, { ...AI_STREAM_HEADERS, ...options.headers });
  // Send the headers now; proxies start forwarding at the first byte.
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    if (!closed) res.write(AI_STREAM_HEARTBEAT_FRAME);
  }, options.heartbeatIntervalMs ?? AI_STREAM_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  function finish(): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    controller.abort();
  }

  // Fires on `end()` and when the client goes away (stop button, tab closed,
  // network) before it: either way the turn is over.
  res.on('close', finish);

  return {
    signal: controller.signal,
    get closed() {
      return closed;
    },
    send(event) {
      if (closed) return false;
      return res.write(formatAiStreamEvent(event));
    },
    close() {
      if (closed) return;
      finish();
      res.end();
    },
  };
}
