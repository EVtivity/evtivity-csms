// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Mock provider HTTP server for tests. Adapters point their base URL at it;
 * it replays recorded wire responses (status, headers, body chunks with
 * optional delays) in the order they were queued, records every request, and
 * notices when a client aborts mid-stream.
 *
 * Test-only: listens on 127.0.0.1 with a random port. Never imported by
 * production code.
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface WireChunk {
  data: string;
  /** Wait this long before writing the chunk. */
  delayMs?: number;
}

export interface WireFixture {
  status?: number;
  headers?: Readonly<Record<string, string>>;
  /** A whole body, or chunks written one by one (streaming). */
  body: string | readonly WireChunk[];
  /** Keep the response open after the last chunk until the client goes away. */
  hang?: boolean;
}

export interface RecordedRequest {
  method: string;
  /** Path and query, as sent (`/v1/messages?beta=true`). */
  url: string;
  path: string;
  /** Lower-cased header names. */
  headers: Readonly<Record<string, string>>;
  body: string;
  /** True when the client closed the connection before the response ended. */
  aborted: boolean;
}

export type MockProviderHandler = (req: RecordedRequest) => WireFixture;

export interface MockProviderServer {
  readonly baseUrl: string;
  readonly requests: readonly RecordedRequest[];
  /** Queues fixtures, served one per request in order. */
  enqueue(...fixtures: WireFixture[]): void;
  /** Serves every request through `handler` (overrides the queue). */
  setHandler(handler: MockProviderHandler | null): void;
  lastRequest(): RecordedRequest;
  /** Resolves when request `index` (default: the last) was aborted by the client. */
  waitForAbort(index?: number, timeoutMs?: number): Promise<void>;
  /** Clears the queue, the handler and the recorded requests. */
  reset(): void;
  close(): Promise<void>;
}

/** Builds SSE chunks (`data: <json>\n\n`) from payloads, with an optional delay each. */
export function sseChunks(
  payloads: readonly unknown[],
  options: { delayMs?: number; event?: (payload: unknown) => string | undefined } = {},
): WireChunk[] {
  return payloads.map((payload) => {
    const eventName = options.event?.(payload);
    const data =
      (eventName !== undefined ? `event: ${eventName}\n` : '') +
      `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
    return options.delayMs !== undefined ? { data, delayMs: options.delayMs } : { data };
  });
}

/** Reads a recorded fixture file (JSON with the `WireFixture` shape). */
export async function loadWireFixture(path: string): Promise<WireFixture> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || !('body' in parsed)) {
    throw new Error(`Wire fixture ${path} has no body`);
  }
  return parsed as WireFixture;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
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
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

export async function startMockProviderServer(): Promise<MockProviderServer> {
  const queue: WireFixture[] = [];
  const requests: RecordedRequest[] = [];
  const abortWaiters = new Map<RecordedRequest, (() => void)[]>();
  let handler: MockProviderHandler | null = null;

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const url = req.url ?? '/';
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      url,
      path: url.split('?')[0] ?? url,
      headers,
      body,
      aborted: false,
    };
    requests.push(recorded);

    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) {
        recorded.aborted = true;
        for (const resolve of abortWaiters.get(recorded) ?? []) resolve();
        abortWaiters.delete(recorded);
      }
      gone.abort();
    });

    const fixture = handler !== null ? handler(recorded) : queue.shift();
    if (fixture === undefined) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'mock provider: no fixture queued' }));
      return;
    }

    res.writeHead(fixture.status ?? 200, { ...fixture.headers });
    res.flushHeaders();
    const chunks = typeof fixture.body === 'string' ? [{ data: fixture.body }] : fixture.body;
    for (const chunk of chunks) {
      if (chunk.delayMs !== undefined) await sleep(chunk.delayMs, gone.signal);
      if (gone.signal.aborted) return;
      res.write(chunk.data);
    }
    if (fixture.hang === true) return;
    res.end();
  }

  const server = createServer((req, res) => {
    serve(req, res).catch((err: unknown) => {
      // Test server: report the failure to the client that triggered it.
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`mock provider error: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    requests,
    enqueue(...fixtures) {
      queue.push(...fixtures);
    },
    setHandler(next) {
      handler = next;
    },
    lastRequest() {
      const last = requests.at(-1);
      if (last === undefined) throw new Error('mock provider: no request received');
      return last;
    },
    waitForAbort(index, timeoutMs = 2000) {
      const target = index === undefined ? requests.at(-1) : requests[index];
      if (target === undefined) return Promise.reject(new Error('mock provider: no such request'));
      if (target.aborted) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(`mock provider: request was not aborted within ${String(timeoutMs)} ms`),
          );
        }, timeoutMs);
        const list = abortWaiters.get(target) ?? [];
        list.push(() => {
          clearTimeout(timer);
          resolve();
        });
        abortWaiters.set(target, list);
      });
    },
    reset() {
      queue.length = 0;
      requests.length = 0;
      abortWaiters.clear();
      handler = null;
    },
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
