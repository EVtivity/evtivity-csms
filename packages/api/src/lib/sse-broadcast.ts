// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from '@evtivity/lib';

interface SseWritable {
  reply: { raw: { write: (chunk: string) => boolean } };
}

interface WriteToClientOptions<T extends SseWritable> {
  client: T;
  payload: string;
  logger: Logger;
  onDeadClient: (client: T) => void;
  describe: (client: T) => Record<string, unknown>;
}

export function writeSseClient<T extends SseWritable>(options: WriteToClientOptions<T>): void {
  const { client, payload, logger, onDeadClient, describe } = options;
  try {
    client.reply.raw.write(payload);
  } catch (err: unknown) {
    logger.warn({ err, ...describe(client) }, 'SSE write failed, dropping client');
    onDeadClient(client);
  }
}

interface SseEndable {
  reply: { raw: { end: () => unknown } };
}

/**
 * Ends every open SSE response and empties the set. Routes call it from a
 * `preClose` hook: Fastify's `close()` waits for in-flight requests before it
 * runs `onClose`, and an open event stream never finishes on its own, so
 * without this a shutdown would wait until the process is killed. Browsers
 * reconnect (EventSource retry) to another instance.
 */
export function endSseClients<T extends SseEndable>(clients: Set<T>, logger: Logger): void {
  for (const client of [...clients]) {
    try {
      client.reply.raw.end();
    } catch (err: unknown) {
      logger.warn({ err }, 'Ending SSE stream at shutdown failed');
    }
  }
  clients.clear();
}
