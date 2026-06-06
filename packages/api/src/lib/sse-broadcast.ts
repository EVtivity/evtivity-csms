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
