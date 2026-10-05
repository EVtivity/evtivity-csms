// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type { PubSubClient } from '../pubsub.js';
import { publishOcppCommand, OCPP_COMMANDS_CHANNEL } from '../ocpp-command-publish.js';

function makePubSub(): { pubsub: PubSubClient; publish: ReturnType<typeof vi.fn> } {
  const publish = vi.fn(async () => {});
  const pubsub = {
    publish,
    subscribe: vi.fn(),
    close: vi.fn(),
  } as unknown as PubSubClient;
  return { pubsub, publish };
}

describe('publishOcppCommand', () => {
  it('publishes the command on ocpp_commands with a generated command id', async () => {
    const { pubsub, publish } = makePubSub();

    const commandId = await publishOcppCommand(pubsub, {
      stationId: 'CS-1',
      action: 'Reset',
      payload: { type: 'Immediate' },
    });

    expect(OCPP_COMMANDS_CHANNEL).toBe('ocpp_commands');
    expect(commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(publish).toHaveBeenCalledTimes(1);
    const [channel, raw] = publish.mock.calls[0] as unknown as [string, string];
    expect(channel).toBe('ocpp_commands');
    expect(JSON.parse(raw)).toEqual({
      commandId,
      stationId: 'CS-1',
      action: 'Reset',
      payload: { type: 'Immediate' },
    });
  });

  it('keeps a given command id and version', async () => {
    const { pubsub, publish } = makePubSub();

    const commandId = await publishOcppCommand(pubsub, {
      commandId: 'cmd-1',
      stationId: 'CS-2',
      action: 'ChangeConfiguration',
      payload: { key: 'HeartbeatInterval', value: '60' },
      version: 'ocpp1.6',
    });

    expect(commandId).toBe('cmd-1');
    const [, raw] = publish.mock.calls[0] as unknown as [string, string];
    expect(JSON.parse(raw)).toEqual({
      commandId: 'cmd-1',
      stationId: 'CS-2',
      action: 'ChangeConfiguration',
      payload: { key: 'HeartbeatInterval', value: '60' },
      version: 'ocpp1.6',
    });
  });

  it('leaves out a null version so the OCPP server translates the command', async () => {
    const { pubsub, publish } = makePubSub();

    await publishOcppCommand(pubsub, {
      stationId: 'CS-3',
      action: 'RequestStopTransaction',
      payload: { transactionId: 'tx-1' },
      version: null,
    });

    const [, raw] = publish.mock.calls[0] as unknown as [string, string];
    expect(JSON.parse(raw)).not.toHaveProperty('version');
  });

  it('propagates a publish failure to the caller', async () => {
    const { pubsub, publish } = makePubSub();
    publish.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      publishOcppCommand(pubsub, { stationId: 'CS-4', action: 'Reset', payload: {} }),
    ).rejects.toThrow('redis down');
  });
});
