// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { PubSubClient, Subscription } from '@evtivity/lib';
import { CommandListener } from '../server/command-listener.js';

vi.mock('../protocol/message-types.js', () => ({
  MESSAGE_TYPE_CALL: 2,
  MESSAGE_TYPE_CALLRESULT: 3,
  MESSAGE_TYPE_CALLERROR: 4,
}));

const logger = pino({ level: 'silent' });

describe('CommandListener', () => {
  let dispatcher: {
    sendCommand: ReturnType<typeof vi.fn>;
    sendVersionAwareCommand: ReturnType<typeof vi.fn>;
  };
  let eventBus: { publish: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
  let pubsub: PubSubClient;
  let subscribeHandler: ((payload: string) => void) | null;
  let mockUnsubscribe: ReturnType<typeof vi.fn>;
  let mockPublish: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    subscribeHandler = null;
    mockUnsubscribe = vi.fn().mockResolvedValue(undefined);
    mockPublish = vi.fn().mockResolvedValue(undefined);

    pubsub = {
      publish: mockPublish,
      subscribe: vi.fn((_channel: string, handler: (payload: string) => void) => {
        subscribeHandler = handler;
        const subscription: Subscription = { unsubscribe: mockUnsubscribe };
        return Promise.resolve(subscription);
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    dispatcher = {
      sendCommand: vi.fn().mockResolvedValue({ status: 'Accepted' }),
      sendVersionAwareCommand: vi.fn().mockResolvedValue({ status: 'Accepted' }),
    };
    eventBus = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
    };
  });

  async function createAndStart() {
    const listener = new CommandListener(pubsub, dispatcher as never, logger, eventBus as never);
    await listener.start();
    return listener;
  }

  it('starts listening on the ocpp_commands channel', async () => {
    await createAndStart();
    expect(pubsub.subscribe).toHaveBeenCalledWith('ocpp_commands', expect.any(Function));
    expect(subscribeHandler).not.toBeNull();
  });

  it('dispatches version-aware command when version is absent', async () => {
    await createAndStart();
    const payload = JSON.stringify({
      stationId: 'CS-001',
      action: 'Reset',
      payload: { type: 'Soft' },
    });

    subscribeHandler!(payload);
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatcher.sendVersionAwareCommand).toHaveBeenCalledWith('CS-001', 'Reset', {
      type: 'Soft',
    });
  });

  it('dispatches direct command when version is present', async () => {
    await createAndStart();
    const payload = JSON.stringify({
      stationId: 'CS-001',
      action: 'Reset',
      payload: { type: 'Soft' },
      version: 'ocpp2.1',
    });

    subscribeHandler!(payload);
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatcher.sendCommand).toHaveBeenCalledWith('CS-001', 'Reset', { type: 'Soft' });
  });

  it('publishes outbound CALL message log', async () => {
    await createAndStart();
    const payload = JSON.stringify({
      commandId: 'cmd-1',
      stationId: 'CS-001',
      action: 'Reset',
      payload: { type: 'Soft' },
    });

    subscribeHandler!(payload);
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.MessageLog',
        payload: expect.objectContaining({
          direction: 'outbound',
          messageType: 2,
          action: 'Reset',
        }) as unknown,
      }),
    );
  });

  it('publishes inbound CALLRESULT on success', async () => {
    await createAndStart();
    const payload = JSON.stringify({
      commandId: 'cmd-1',
      stationId: 'CS-001',
      action: 'Reset',
      payload: {},
    });

    subscribeHandler!(payload);
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.MessageLog',
        payload: expect.objectContaining({
          direction: 'inbound',
          messageType: 3,
        }) as unknown,
      }),
    );
  });

  it('publishes command result via pubsub on success', async () => {
    await createAndStart();
    const payload = JSON.stringify({
      commandId: 'cmd-1',
      stationId: 'CS-001',
      action: 'Reset',
      payload: {},
    });

    subscribeHandler!(payload);
    await new Promise((r) => setTimeout(r, 10));

    expect(mockPublish).toHaveBeenCalledWith(
      'ocpp_command_results',
      JSON.stringify({ commandId: 'cmd-1', response: { status: 'Accepted' } }),
    );
  });

  it('publishes inbound CALLERROR on failure', async () => {
    dispatcher.sendVersionAwareCommand.mockRejectedValueOnce(new Error('Station not connected'));

    await createAndStart();
    const payload = JSON.stringify({
      stationId: 'CS-001',
      action: 'Reset',
      payload: {},
    });

    subscribeHandler!(payload);
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.MessageLog',
        payload: expect.objectContaining({
          direction: 'inbound',
          messageType: 4,
          errorCode: 'InternalError',
        }) as unknown,
      }),
    );
  });

  it('publishes error result via pubsub on failure', async () => {
    dispatcher.sendVersionAwareCommand.mockRejectedValueOnce(new Error('Station not connected'));

    await createAndStart();
    const payload = JSON.stringify({
      commandId: 'cmd-2',
      stationId: 'CS-001',
      action: 'Reset',
      payload: {},
    });

    subscribeHandler!(payload);
    await new Promise((r) => setTimeout(r, 10));

    expect(mockPublish).toHaveBeenCalledWith(
      'ocpp_command_results',
      JSON.stringify({ commandId: 'cmd-2', error: 'Station not connected' }),
    );
  });

  it('handles invalid JSON gracefully', async () => {
    await createAndStart();

    subscribeHandler!('not-valid-json');
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatcher.sendCommand).not.toHaveBeenCalled();
    expect(dispatcher.sendVersionAwareCommand).not.toHaveBeenCalled();
  });

  it('stops by unsubscribing', async () => {
    const listener = await createAndStart();

    await listener.stop();

    expect(mockUnsubscribe).toHaveBeenCalled();
  });

  it('publishes command.SetChargingProfile event on SetChargingProfile success', async () => {
    await createAndStart();
    const payload = JSON.stringify({
      commandId: 'cmd-10',
      stationId: 'CS-001',
      action: 'SetChargingProfile',
      payload: { evseId: 1, chargingProfile: {} },
    });

    subscribeHandler!(payload);
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'command.SetChargingProfile',
        aggregateType: 'ChargingStation',
        aggregateId: 'CS-001',
        payload: {
          request: { evseId: 1, chargingProfile: {} },
          response: { status: 'Accepted' },
        },
      }),
    );
  });

  it('publishes command.Queued event when station is not connected and commandId present', async () => {
    dispatcher.sendVersionAwareCommand.mockRejectedValueOnce(
      new Error('Station CS-001 is not connected'),
    );

    await createAndStart();
    const payload = JSON.stringify({
      commandId: 'cmd-20',
      stationId: 'CS-001',
      action: 'Reset',
      payload: { type: 'Soft' },
    });

    subscribeHandler!(payload);
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'command.Queued',
        aggregateType: 'ChargingStation',
        aggregateId: 'CS-001',
        payload: expect.objectContaining({
          commandId: 'cmd-20',
          stationId: 'CS-001',
          action: 'Reset',
        }) as unknown,
      }),
    );
  });

  it('sends queued result via pubsub when station offline', async () => {
    dispatcher.sendVersionAwareCommand.mockRejectedValueOnce(
      new Error('Station CS-001 is not connected'),
    );

    await createAndStart();
    const payload = JSON.stringify({
      commandId: 'cmd-21',
      stationId: 'CS-001',
      action: 'Reset',
      payload: { type: 'Soft' },
    });

    subscribeHandler!(payload);
    await new Promise((r) => setTimeout(r, 10));

    expect(mockPublish).toHaveBeenCalledWith(
      'ocpp_command_results',
      JSON.stringify({
        commandId: 'cmd-21',
        error: 'Station offline, command queued',
        queued: true,
      }),
    );

    // Should NOT publish a CALLERROR message log
    const callErrorCalls = eventBus.publish.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { payload?: { messageType?: number } }).payload?.messageType === 4,
    );
    expect(callErrorCalls).toHaveLength(0);
  });

  it('skips dispatch when registry shows another instance owns the station', async () => {
    const mockRegistry = {
      register: vi.fn(),
      unregister: vi.fn(),
      getInstanceId: vi.fn().mockResolvedValue('instance-2'),
    };

    const listener = new CommandListener(pubsub, dispatcher as never, logger, eventBus as never, {
      registry: mockRegistry,
      instanceId: 'instance-1',
    });
    await listener.start();

    const payload = JSON.stringify({
      stationId: 'CS-001',
      action: 'Reset',
      payload: { type: 'Soft' },
    });

    subscribeHandler!(payload);
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatcher.sendCommand).not.toHaveBeenCalled();
    expect(dispatcher.sendVersionAwareCommand).not.toHaveBeenCalled();
  });

  it('proceeds with dispatch when registry shows same instance owns station', async () => {
    const mockRegistry = {
      register: vi.fn(),
      unregister: vi.fn(),
      getInstanceId: vi.fn().mockResolvedValue('instance-1'),
    };

    const listener = new CommandListener(pubsub, dispatcher as never, logger, eventBus as never, {
      registry: mockRegistry,
      instanceId: 'instance-1',
    });
    await listener.start();

    const payload = JSON.stringify({
      stationId: 'CS-001',
      action: 'Reset',
      payload: { type: 'Soft' },
    });

    subscribeHandler!(payload);
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatcher.sendVersionAwareCommand).toHaveBeenCalledWith('CS-001', 'Reset', {
      type: 'Soft',
    });
  });

  // ---- Retry behavior ----

  it('retries retryable commands on timeout error', async () => {
    dispatcher.sendCommand
      .mockRejectedValueOnce(new Error('Command timed out'))
      .mockResolvedValueOnce({ status: 'Accepted' });

    await createAndStart();
    const payload = JSON.stringify({
      commandId: 'cmd-retry',
      stationId: 'CS-001',
      action: 'Reset',
      payload: { type: 'Soft' },
      version: 'ocpp2.1',
    });

    subscribeHandler!(payload);
    // Wait for retry delay (exponential backoff)
    await new Promise((r) => setTimeout(r, 2000));

    expect(dispatcher.sendCommand).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable commands on timeout', async () => {
    dispatcher.sendVersionAwareCommand.mockRejectedValueOnce(new Error('Command timed out'));

    await createAndStart();
    const payload = JSON.stringify({
      commandId: 'cmd-noretry',
      stationId: 'CS-001',
      action: 'RequestStartTransaction',
      payload: {},
    });

    subscribeHandler!(payload);
    await new Promise((r) => setTimeout(r, 100));

    // Non-retryable: should only be called once
    expect(dispatcher.sendVersionAwareCommand).toHaveBeenCalledTimes(1);
  });

  it('does not retry on non-timeout errors even for retryable commands', async () => {
    dispatcher.sendCommand.mockRejectedValueOnce(new Error('Station rejected: NotImplemented'));

    await createAndStart();
    const payload = JSON.stringify({
      commandId: 'cmd-nontimeout',
      stationId: 'CS-001',
      action: 'GetLog',
      payload: {},
      version: 'ocpp2.1',
    });

    subscribeHandler!(payload);
    await new Promise((r) => setTimeout(r, 100));

    // shouldRetry returns false for non-timeout errors
    expect(dispatcher.sendCommand).toHaveBeenCalledTimes(1);
  });

  it('publishes command.GetDiagnostics event on success', async () => {
    await createAndStart();
    const payload = JSON.stringify({
      commandId: 'cmd-diag',
      stationId: 'CS-001',
      action: 'GetDiagnostics',
      payload: { location: 'ftp://example.com' },
      version: 'ocpp1.6',
    });

    subscribeHandler!(payload);
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'command.GetDiagnostics',
        aggregateType: 'ChargingStation',
        aggregateId: 'CS-001',
      }),
    );
  });
});
