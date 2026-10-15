// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import pino from 'pino';
import type { PubSubClient, Subscription, DomainEvent } from '@evtivity/lib';
import { CommandListener } from '../server/command-listener.js';
import {
  clearIssuedCentralTokens,
  isIssuedCentralToken,
} from '../authorization/issued-central-tokens.js';
import { CommandTimeoutError } from '../server/message-correlator.js';

vi.mock('../protocol/message-types.js', () => ({
  MESSAGE_TYPE_CALL: 2,
  MESSAGE_TYPE_CALLRESULT: 3,
  MESSAGE_TYPE_CALLERROR: 4,
}));

const logger = pino({ level: 'silent' });

describe('CommandListener', () => {
  let dispatcher: {
    sendCommand: Mock;
    sendVersionAwareCommand: Mock;
  };
  let eventBus: {
    publish: Mock<(event: DomainEvent) => Promise<void>>;
    subscribe: Mock;
    drain: Mock<(timeoutMs: number) => Promise<boolean>>;
    track: Mock;
  };
  let pubsub: PubSubClient;
  let subscribeHandler: ((payload: string) => void) | null;
  let mockUnsubscribe: Mock<() => Promise<void>>;
  let mockPublish: Mock<(channel: string, payload: string) => Promise<void>>;

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

    // Like the real dispatcher, the CALL goes out (onSend) before the response.
    const sendAndAccept = (
      _stationId: string,
      _action: string,
      _payload: Record<string, unknown>,
      options?: { onSend?: () => void },
    ): Promise<Record<string, unknown>> => {
      options?.onSend?.();
      return Promise.resolve({ status: 'Accepted' });
    };
    dispatcher = {
      sendCommand: vi.fn(sendAndAccept),
      sendVersionAwareCommand: vi.fn(sendAndAccept),
    };
    eventBus = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      drain: vi.fn().mockResolvedValue(true),
      track: vi.fn(),
    };
  });

  async function createAndStart() {
    const listener = new CommandListener(pubsub, dispatcher as never, logger, eventBus);
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

    expect(dispatcher.sendVersionAwareCommand).toHaveBeenCalledWith(
      'CS-001',
      'Reset',
      { type: 'Soft' },
      { onSend: expect.any(Function) },
    );
  });

  it('remembers the Central idToken of a remote start for Authorize', async () => {
    clearIssuedCentralTokens();
    await createAndStart();
    subscribeHandler!(
      JSON.stringify({
        stationId: 'CS-001',
        action: 'RequestStartTransaction',
        payload: { evseId: 1, remoteStartId: 7, idToken: { idToken: 'drv-x', type: 'Central' } },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(isIssuedCentralToken('CS-001', 'drv-x')).toBe(true);
    expect(isIssuedCentralToken('CS-002', 'drv-x')).toBe(false);
    clearIssuedCentralTokens();
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

    expect(dispatcher.sendCommand).toHaveBeenCalledWith(
      'CS-001',
      'Reset',
      { type: 'Soft' },
      { onSend: expect.any(Function) },
    );
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

  it('logs the outbound CALL when the dispatcher sends it, not when it is received', async () => {
    let send: (() => void) | undefined;
    let answer: ((response: Record<string, unknown>) => void) | undefined;
    dispatcher.sendVersionAwareCommand.mockImplementationOnce(
      (_s: string, _a: string, _p: unknown, options?: { onSend?: () => void }) => {
        send = options?.onSend;
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    );
    await createAndStart();
    subscribeHandler!(
      JSON.stringify({ commandId: 'cmd-q', stationId: 'CS-001', action: 'Reset', payload: {} }),
    );
    await new Promise((r) => setTimeout(r, 10));

    const callLogs = (): unknown[] =>
      eventBus.publish.mock.calls.filter(
        ([e]) =>
          e.eventType === 'ocpp.MessageLog' &&
          (e.payload as { messageType?: number }).messageType === 2,
      );
    // Still waiting behind the station's outstanding CALL: nothing on the wire yet.
    expect(callLogs()).toHaveLength(0);

    send?.();
    expect(callLogs()).toHaveLength(1);
    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.MessageLog',
        payload: expect.objectContaining({
          direction: 'outbound',
          messageType: 2,
          messageId: 'cmd-q',
          action: 'Reset',
        }) as unknown,
      }),
    );
    answer?.({ status: 'Accepted' });
    await new Promise((r) => setTimeout(r, 10));
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

  it('publishes timedOut on the result when the station does not answer', async () => {
    dispatcher.sendVersionAwareCommand.mockRejectedValueOnce(
      new CommandTimeoutError('ReserveNow', 'msg-1'),
    );

    await createAndStart();
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-to',
        stationId: 'CS-001',
        action: 'ReserveNow',
        payload: {},
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(mockPublish).toHaveBeenCalledWith(
      'ocpp_command_results',
      JSON.stringify({
        commandId: 'cmd-to',
        error: 'Timeout waiting for response to ReserveNow (msg-1)',
        timedOut: true,
      }),
    );
  });

  it('does not mark an error with timeout words as timedOut unless it is a CommandTimeoutError', async () => {
    dispatcher.sendVersionAwareCommand.mockRejectedValueOnce(
      new Error('Timeout waiting for response to ReserveNow (msg-2)'),
    );

    await createAndStart();
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-nt',
        stationId: 'CS-001',
        action: 'ReserveNow',
        payload: {},
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(mockPublish).toHaveBeenCalledWith(
      'ocpp_command_results',
      JSON.stringify({
        commandId: 'cmd-nt',
        error: 'Timeout waiting for response to ReserveNow (msg-2)',
      }),
    );
  });

  it('handles invalid JSON gracefully', async () => {
    await createAndStart();

    subscribeHandler!('not-valid-json');
    subscribeHandler!('null');
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

  it('publishes command.ClearChargingProfile with the request and the answer', async () => {
    await createAndStart();
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-ccp',
        stationId: 'CS-001',
        action: 'ClearChargingProfile',
        payload: { chargingProfileId: 3 },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'command.ClearChargingProfile',
        aggregateId: 'CS-001',
        payload: { request: { chargingProfileId: 3 }, response: { status: 'Accepted' } },
      }),
    );
  });

  it('publishes command.GetChargingProfiles with the request and the answer', async () => {
    await createAndStart();
    dispatcher.sendCommand.mockResolvedValueOnce({ status: 'NoProfiles' });
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-gcp',
        stationId: 'CS-001',
        action: 'GetChargingProfiles',
        payload: { requestId: 7, chargingProfile: {} },
        version: 'ocpp2.1',
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'command.GetChargingProfiles',
        aggregateId: 'CS-001',
        payload: {
          request: { requestId: 7, chargingProfile: {} },
          response: { status: 'NoProfiles' },
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

  it('never queues a station credential change for an offline station', async () => {
    dispatcher.sendVersionAwareCommand.mockRejectedValueOnce(
      new Error('Station CS-001 is not connected'),
    );
    await createAndStart();
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-pw',
        stationId: 'CS-001',
        action: 'SetVariables',
        payload: {
          setVariableData: [
            {
              component: { name: 'SecurityCtrlr' },
              variable: { name: 'BasicAuthPassword' },
              attributeValue: 'SeedStationPass1234',
            },
          ],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    const types = eventBus.publish.mock.calls.map((c) => c[0].eventType);
    expect(types).not.toContain('command.Queued');
    expect(mockPublish).toHaveBeenCalledWith(
      'ocpp_command_results',
      JSON.stringify({
        commandId: 'cmd-pw',
        error: 'Station offline, a station credential change is not queued',
      }),
    );
    // The outbound CALL row is logged masked.
    expect(JSON.stringify(eventBus.publish.mock.calls)).not.toContain('SeedStationPass1234');
  });

  it('never queues a noQueue command for an offline station and answers an error', async () => {
    dispatcher.sendVersionAwareCommand.mockRejectedValueOnce(
      new Error('Station CS-001 is not connected'),
    );
    await createAndStart();
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-ocpi',
        stationId: 'CS-001',
        action: 'RequestStartTransaction',
        payload: { idToken: { idToken: 'TOK', type: 'ISO14443' }, remoteStartId: 9 },
        noQueue: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    // No command.Queued event: nothing reaches offline_command_queue.
    const types = eventBus.publish.mock.calls.map((c) => c[0].eventType);
    expect(types).not.toContain('command.Queued');
    expect(mockPublish).toHaveBeenCalledWith(
      'ocpp_command_results',
      JSON.stringify({ commandId: 'cmd-ocpi', error: 'Station offline, command not queued' }),
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

    const listener = new CommandListener(pubsub, dispatcher as never, logger, eventBus, {
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

    const listener = new CommandListener(pubsub, dispatcher as never, logger, eventBus, {
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

    expect(dispatcher.sendVersionAwareCommand).toHaveBeenCalledWith(
      'CS-001',
      'Reset',
      { type: 'Soft' },
      { onSend: expect.any(Function) },
    );
  });

  // ---- No retries ----

  it('sends a timed-out command once and reports timedOut', async () => {
    dispatcher.sendCommand
      .mockRejectedValueOnce(new CommandTimeoutError('Reset', 'm1'))
      .mockResolvedValueOnce({ status: 'Accepted' });

    await createAndStart();
    const payload = JSON.stringify({
      commandId: 'cmd-timeout',
      stationId: 'CS-001',
      action: 'Reset',
      payload: { type: 'Soft' },
      version: 'ocpp2.1',
    });

    subscribeHandler!(payload);
    // Longer than the old 1 s first retry delay.
    await new Promise((r) => setTimeout(r, 1500));

    expect(dispatcher.sendCommand).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      'ocpp_command_results',
      JSON.stringify({
        commandId: 'cmd-timeout',
        error: 'Timeout waiting for response to Reset (m1)',
        timedOut: true,
      }),
    );
  });

  it('does not retry on non-timeout errors', async () => {
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

  it('rethrows and logs when subscribing fails', async () => {
    const failingPubsub: PubSubClient = {
      publish: mockPublish,
      subscribe: vi.fn().mockRejectedValue(new Error('Redis unavailable')),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const listener = new CommandListener(failingPubsub, dispatcher as never, logger, eventBus);

    await expect(listener.start()).rejects.toThrow('Redis unavailable');
  });

  it('rethrows when subscribing fails with a non-Error value', async () => {
    const failingPubsub: PubSubClient = {
      publish: mockPublish,
      subscribe: vi.fn().mockRejectedValue('redis string failure'),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const listener = new CommandListener(failingPubsub, dispatcher as never, logger, eventBus);

    await expect(listener.start()).rejects.toBe('redis string failure');
  });

  it('stringifies a non-Error dispatch failure into the error result', async () => {
    dispatcher.sendVersionAwareCommand.mockRejectedValueOnce('plain string failure');
    await createAndStart();
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-strerr',
        stationId: 'CS-001',
        action: 'TriggerMessage',
        payload: {},
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(mockPublish).toHaveBeenCalledWith(
      'ocpp_command_results',
      JSON.stringify({ commandId: 'cmd-strerr', error: 'plain string failure' }),
    );
  });

  it('drops a payload missing required fields without dispatching', async () => {
    await createAndStart();
    // Missing action and payload.
    subscribeHandler!(JSON.stringify({ stationId: 'CS-001' }));
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatcher.sendCommand).not.toHaveBeenCalled();
    expect(dispatcher.sendVersionAwareCommand).not.toHaveBeenCalled();
  });

  it('drops a payload whose commandId is not a string', async () => {
    await createAndStart();
    subscribeHandler!(
      JSON.stringify({ commandId: 123, stationId: 'CS-001', action: 'Reset', payload: {} }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatcher.sendCommand).not.toHaveBeenCalled();
    expect(dispatcher.sendVersionAwareCommand).not.toHaveBeenCalled();
  });

  it('proceeds with dispatch (fail-open) when the registry lookup throws', async () => {
    const mockRegistry = {
      register: vi.fn(),
      unregister: vi.fn(),
      getInstanceId: vi.fn().mockRejectedValue(new Error('registry down')),
    };

    const listener = new CommandListener(pubsub, dispatcher as never, logger, eventBus, {
      registry: mockRegistry,
      instanceId: 'instance-1',
    });
    await listener.start();

    subscribeHandler!(
      JSON.stringify({ stationId: 'CS-001', action: 'Reset', payload: { type: 'Soft' } }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatcher.sendVersionAwareCommand).toHaveBeenCalledWith(
      'CS-001',
      'Reset',
      { type: 'Soft' },
      { onSend: expect.any(Function) },
    );
  });

  it('publishes pnc.InstallCertificateResult on InstallCertificate success', async () => {
    dispatcher.sendCommand.mockResolvedValueOnce({ status: 'Accepted' });
    await createAndStart();
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-cert',
        stationId: 'CS-001',
        action: 'InstallCertificate',
        payload: { certificateType: 'V2GRootCertificate', certificate: 'PEM' },
        version: 'ocpp2.1',
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'pnc.InstallCertificateResult',
        aggregateType: 'ChargingStation',
        aggregateId: 'CS-001',
        payload: expect.objectContaining({
          certificateType: 'V2GRootCertificate',
          status: 'Accepted',
        }) as unknown,
      }),
    );
  });

  it('publishes pnc.CertificateSignedResult with the chain, type and station answer', async () => {
    dispatcher.sendVersionAwareCommand.mockResolvedValueOnce({ status: 'Accepted' });
    await createAndStart();
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-signed',
        stationId: 'CS-001',
        action: 'CertificateSigned',
        payload: { certificateChain: 'PEM', certificateType: 'V2GCertificate', requestId: 3 },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'pnc.CertificateSignedResult',
        aggregateId: 'CS-001',
        payload: {
          certificateChain: 'PEM',
          certificateType: 'V2GCertificate',
          status: 'Accepted',
        },
      }),
    );
  });

  it('types a 1.6 CertificateSigned result as the station certificate', async () => {
    dispatcher.sendCommand.mockResolvedValueOnce({ status: 'Rejected' });
    await createAndStart();
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-signed-16',
        stationId: 'CS-001',
        action: 'CertificateSigned',
        payload: { certificateChain: 'PEM' },
        version: 'ocpp1.6',
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'pnc.CertificateSignedResult',
        payload: expect.objectContaining({
          certificateType: 'ChargingStationCertificate',
          status: 'Rejected',
        }) as unknown,
      }),
    );
  });

  it('publishes command.GetVariables on GetVariables success', async () => {
    await createAndStart();
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-gv',
        stationId: 'CS-001',
        action: 'GetVariables',
        payload: { getVariableData: [] },
        version: 'ocpp2.1',
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'command.GetVariables', aggregateId: 'CS-001' }),
    );
  });

  it('publishes command.GetConfiguration on GetConfiguration success', async () => {
    await createAndStart();
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-gc',
        stationId: 'CS-001',
        action: 'GetConfiguration',
        payload: { key: ['HeartbeatInterval'] },
        version: 'ocpp1.6',
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'command.GetConfiguration', aggregateId: 'CS-001' }),
    );
  });

  it('publishes command.UpdateFirmware on UpdateFirmware success', async () => {
    await createAndStart();
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-fw',
        stationId: 'CS-001',
        action: 'UpdateFirmware',
        payload: { location: 'https://fw', retrieveDate: '2026-01-01T00:00:00Z' },
        version: 'ocpp2.1',
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'command.UpdateFirmware', aggregateId: 'CS-001' }),
    );
  });

  it('publishes command.UpdateFirmware on 1.6 SignedUpdateFirmware success', async () => {
    await createAndStart();
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-sfw',
        stationId: 'CS-001',
        action: 'SignedUpdateFirmware',
        payload: {
          requestId: 5,
          firmware: { location: 'https://fw', retrieveDateTime: '2026-01-01T00:00:00Z' },
        },
        version: 'ocpp1.6',
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'command.UpdateFirmware', aggregateId: 'CS-001' }),
    );
  });

  it('publishes command.UpdateFirmware with the error when the station answers with an error', async () => {
    dispatcher.sendVersionAwareCommand.mockRejectedValueOnce(new Error('NotSupported'));
    await createAndStart();
    const payload = { requestId: 9, firmware: { location: 'https://fw' } };
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-fw-err',
        stationId: 'CS-001',
        action: 'UpdateFirmware',
        payload,
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'command.UpdateFirmware',
        payload: { request: payload, error: 'NotSupported' },
      }),
    );
  });

  it('publishes command.SetChargingProfile with the error when the station answers CALLERROR', async () => {
    dispatcher.sendVersionAwareCommand.mockRejectedValueOnce(
      new Error('CALLERROR NotSupported: no smart charging'),
    );
    await createAndStart();
    const payload = { evseId: 0, chargingProfile: { id: 1000000000, stackLevel: 1 } };
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-cp-err',
        stationId: 'CS-001',
        action: 'SetChargingProfile',
        payload,
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'command.SetChargingProfile',
        payload: { request: payload, error: 'CALLERROR NotSupported: no smart charging' },
      }),
    );
  });

  it('does not report a charging profile refused when it could not be sent', async () => {
    dispatcher.sendVersionAwareCommand.mockRejectedValueOnce(
      new Error('Station CS-001 is not connected'),
    );
    await createAndStart();
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-cp-send',
        stationId: 'CS-001',
        action: 'SetChargingProfile',
        payload: { evseId: 0, chargingProfile: { id: 1000000000 } },
        noQueue: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'command.SetChargingProfile' }),
    );
  });

  it('does not end a firmware update whose command timed out', async () => {
    dispatcher.sendVersionAwareCommand.mockRejectedValueOnce(
      new CommandTimeoutError('UpdateFirmware', 'm2'),
    );
    await createAndStart();
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-fw-to',
        stationId: 'CS-001',
        action: 'UpdateFirmware',
        payload: { requestId: 10, firmware: { location: 'https://fw' } },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'command.UpdateFirmware' }),
    );
  });

  it('publishes command.GetLog on GetLog success', async () => {
    await createAndStart();
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-log',
        stationId: 'CS-001',
        action: 'GetLog',
        payload: { logType: 'DiagnosticsLog' },
        version: 'ocpp2.1',
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'command.GetLog', aggregateId: 'CS-001' }),
    );
  });

  it('publishes command.ReserveNow on ReserveNow success so projections can roll back', async () => {
    dispatcher.sendVersionAwareCommand.mockResolvedValueOnce({ status: 'Occupied' });
    await createAndStart();
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-resv',
        stationId: 'CS-001',
        action: 'ReserveNow',
        payload: { id: 7, evseId: 1 },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'command.ReserveNow',
        aggregateId: 'CS-001',
        payload: {
          request: { id: 7, evseId: 1 },
          response: { status: 'Occupied' },
        },
      }),
    );
  });

  it.each([
    ['ClearDisplayMessage', { id: 3 }, { status: 'Accepted' }],
    ['SetDisplayMessage', { message: { id: 3 } }, { status: 'Rejected' }],
  ])(
    'publishes command.%s with the station reply so the projection records it',
    async (action, payload, response) => {
      dispatcher.sendVersionAwareCommand.mockResolvedValueOnce(response);
      await createAndStart();
      subscribeHandler!(
        JSON.stringify({ commandId: 'cmd-dm', stationId: 'CS-001', action, payload }),
      );
      await new Promise((r) => setTimeout(r, 10));

      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: `command.${action}`,
          aggregateId: 'CS-001',
          payload: { request: payload, response },
        }),
      );
    },
  );

  it('publishes CALLERROR and error result for a non-offline failure with commandId', async () => {
    dispatcher.sendVersionAwareCommand.mockRejectedValueOnce(
      new Error('Station rejected: NotImplemented'),
    );
    await createAndStart();
    subscribeHandler!(
      JSON.stringify({
        commandId: 'cmd-err',
        stationId: 'CS-001',
        action: 'TriggerMessage',
        payload: {},
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.MessageLog',
        payload: expect.objectContaining({
          direction: 'inbound',
          messageType: 4,
          errorDescription: 'Station rejected: NotImplemented',
        }) as unknown,
      }),
    );
    expect(mockPublish).toHaveBeenCalledWith(
      'ocpp_command_results',
      JSON.stringify({ commandId: 'cmd-err', error: 'Station rejected: NotImplemented' }),
    );
  });
});
