// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { writeSseClient } from '../lib/sse-broadcast.js';

interface TestClient {
  id: number;
  reply: { raw: { write: (chunk: string) => boolean } };
}

function makeClient(id: number, write: (chunk: string) => boolean): TestClient {
  return { id, reply: { raw: { write } } };
}

const silentLogger = {
  warn: vi.fn(),
} as unknown as Parameters<typeof writeSseClient<TestClient>>[0]['logger'];

describe('writeSseClient', () => {
  it('writes the payload to a healthy client without pruning', () => {
    const write = vi.fn<(chunk: string) => boolean>().mockReturnValue(true);
    const client = makeClient(1, write);
    const onDeadClient = vi.fn<(c: TestClient) => void>();

    writeSseClient({
      client,
      payload: 'data: ok\n\n',
      logger: silentLogger,
      onDeadClient,
      describe: (c) => ({ clientId: c.id }),
    });

    expect(write).toHaveBeenCalledWith('data: ok\n\n');
    expect(onDeadClient).not.toHaveBeenCalled();
  });

  it('prunes the client and does not rethrow when the write throws', () => {
    const write = vi.fn<(chunk: string) => boolean>().mockImplementation(() => {
      throw new Error('socket closed');
    });
    const client = makeClient(7, write);
    const onDeadClient = vi.fn<(c: TestClient) => void>();

    expect(() =>
      writeSseClient({
        client,
        payload: 'data: boom\n\n',
        logger: silentLogger,
        onDeadClient,
        describe: (c) => ({ clientId: c.id }),
      }),
    ).not.toThrow();

    expect(onDeadClient).toHaveBeenCalledWith(client);
  });

  it('a throwing client does not prevent delivery to the next client and prunes only the dead one', () => {
    const clients = new Set<TestClient>();

    const deadWrite = vi.fn<(chunk: string) => boolean>().mockImplementation(() => {
      throw new Error('dead socket');
    });
    const liveWrite = vi.fn<(chunk: string) => boolean>().mockReturnValue(true);

    const deadClient = makeClient(1, deadWrite);
    const liveClient = makeClient(2, liveWrite);
    clients.add(deadClient);
    clients.add(liveClient);

    const onDeadClient = (c: TestClient): void => {
      clients.delete(c);
    };

    const message = 'data: broadcast\n\n';
    for (const client of clients) {
      writeSseClient({
        client,
        payload: message,
        logger: silentLogger,
        onDeadClient,
        describe: (c) => ({ clientId: c.id }),
      });
    }

    expect(deadWrite).toHaveBeenCalledWith(message);
    expect(liveWrite).toHaveBeenCalledWith(message);
    expect(clients.has(deadClient)).toBe(false);
    expect(clients.has(liveClient)).toBe(true);
  });
});
