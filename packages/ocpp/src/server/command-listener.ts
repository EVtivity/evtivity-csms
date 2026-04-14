// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type {
  Logger,
  EventBus,
  PubSubClient,
  Subscription,
  ConnectionRegistry,
} from '@evtivity/lib';
import type { CommandDispatcher } from './command-dispatcher.js';
import { RetryPolicy } from './retry-policy.js';
import {
  MESSAGE_TYPE_CALL,
  MESSAGE_TYPE_CALLRESULT,
  MESSAGE_TYPE_CALLERROR,
} from '../protocol/message-types.js';

const CHANNEL = 'ocpp_commands';

const RESULTS_CHANNEL = 'ocpp_command_results';

const NON_RETRYABLE_ACTIONS = new Set([
  'RequestStartTransaction',
  'RemoteStartTransaction',
  'RequestStopTransaction',
  'RemoteStopTransaction',
  'ReserveNow',
  'CancelReservation',
]);

interface CommandPayload {
  commandId?: string;
  stationId: string;
  action: string;
  payload: Record<string, unknown>;
  version?: string;
}

export interface CommandListenerOptions {
  registry?: ConnectionRegistry;
  instanceId?: string;
}

export class CommandListener {
  private readonly pubsub: PubSubClient;
  private readonly dispatcher: CommandDispatcher;
  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  private readonly registry: ConnectionRegistry | null;
  private readonly instanceId: string | null;
  private readonly retryPolicy: RetryPolicy;
  private subscription: Subscription | null = null;

  constructor(
    pubsub: PubSubClient,
    dispatcher: CommandDispatcher,
    logger: Logger,
    eventBus: EventBus,
    options?: CommandListenerOptions,
  ) {
    this.pubsub = pubsub;
    this.dispatcher = dispatcher;
    this.logger = logger;
    this.eventBus = eventBus;
    this.registry = options?.registry ?? null;
    this.instanceId = options?.instanceId ?? null;
    this.retryPolicy = new RetryPolicy(logger);
  }

  async start(): Promise<void> {
    try {
      this.subscription = await this.pubsub.subscribe(CHANNEL, (payload: string) => {
        void this.handleNotification(payload);
      });
      this.logger.info({ channel: CHANNEL }, 'Listening for OCPP commands from event source');
    } catch (err) {
      this.logger.error(
        { channel: CHANNEL, error: err instanceof Error ? err.message : String(err) },
        'Failed to subscribe to OCPP commands channel',
      );
      throw err;
    }
  }

  private async handleNotification(raw: string): Promise<void> {
    let command: CommandPayload;
    try {
      command = JSON.parse(raw) as CommandPayload;
    } catch {
      this.logger.error({ raw }, 'Invalid command payload from event source');
      return;
    }

    if (
      typeof command.stationId !== 'string' ||
      typeof command.action !== 'string' ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime check for untrusted JSON
      command.payload == null
    ) {
      this.logger.error({ raw }, 'Malformed command payload: missing required fields');
      return;
    }

    if (command.commandId != null && typeof command.commandId !== 'string') {
      this.logger.error({ raw }, 'Malformed command payload: commandId must be a string');
      return;
    }

    const { commandId, stationId, action, payload, version } = command;
    this.logger.info({ commandId, stationId, action }, 'Received command from event source');

    // In multi-instance mode, skip commands for stations owned by another instance
    if (this.registry != null && this.instanceId != null) {
      try {
        const owner = await this.registry.getInstanceId(stationId);
        if (owner != null && owner !== this.instanceId) {
          this.logger.debug(
            { stationId, owner, instanceId: this.instanceId },
            'Station owned by another instance, skipping',
          );
          return;
        }
      } catch {
        // Registry unavailable: proceed with dispatch (fail-open)
      }
    }

    // Log outbound CALL to station
    const messageId = commandId ?? crypto.randomUUID();
    void this.eventBus.publish({
      eventType: 'ocpp.MessageLog',
      aggregateType: 'ChargingStation',
      aggregateId: stationId,
      payload: {
        stationId,
        direction: 'outbound',
        messageType: MESSAGE_TYPE_CALL,
        messageId,
        action,
        payload,
      },
    });

    try {
      // When version is present, the frontend sent a version-native payload -- dispatch directly.
      // When absent, use version-aware translation for programmatic callers (reservations, etc.).
      const dispatch = () =>
        version != null
          ? this.dispatcher.sendCommand(stationId, action, payload)
          : this.dispatcher.sendVersionAwareCommand(stationId, action, payload);

      // Retry retryable commands on timeout errors only
      const isRetryable = !NON_RETRYABLE_ACTIONS.has(action);
      const shouldRetry = (err: Error) =>
        !err.message.includes('is not connected') && err.message.includes('timed out');

      const response = isRetryable
        ? await this.retryPolicy.execute(action, dispatch, shouldRetry)
        : await dispatch();
      this.logger.info({ stationId, action, response }, 'Command completed');

      // Log inbound CALLRESULT from station
      void this.eventBus.publish({
        eventType: 'ocpp.MessageLog',
        aggregateType: 'ChargingStation',
        aggregateId: stationId,
        payload: {
          stationId,
          direction: 'inbound',
          messageType: MESSAGE_TYPE_CALLRESULT,
          messageId,
          action,
          payload: response,
        },
      });

      // Publish domain events for certificate commands so projections can save results
      if (action === 'InstallCertificate') {
        void this.eventBus.publish({
          eventType: 'pnc.InstallCertificateResult',
          aggregateType: 'ChargingStation',
          aggregateId: stationId,
          payload: { ...payload, status: response.status },
        });
      }

      // Command tracking: publish events so projections can persist results
      if (action === 'SetChargingProfile') {
        void this.eventBus.publish({
          eventType: 'command.SetChargingProfile',
          aggregateType: 'ChargingStation',
          aggregateId: stationId,
          payload: { request: payload, response },
        });
      } else if (action === 'GetVariables') {
        void this.eventBus.publish({
          eventType: 'command.GetVariables',
          aggregateType: 'ChargingStation',
          aggregateId: stationId,
          payload: { request: payload, response },
        });
      } else if (action === 'GetConfiguration') {
        void this.eventBus.publish({
          eventType: 'command.GetConfiguration',
          aggregateType: 'ChargingStation',
          aggregateId: stationId,
          payload: { request: payload, response },
        });
      } else if (action === 'UpdateFirmware') {
        void this.eventBus.publish({
          eventType: 'command.UpdateFirmware',
          aggregateType: 'ChargingStation',
          aggregateId: stationId,
          payload: { request: payload, response },
        });
      } else if (action === 'GetLog') {
        void this.eventBus.publish({
          eventType: 'command.GetLog',
          aggregateType: 'ChargingStation',
          aggregateId: stationId,
          payload: { request: payload, response },
        });
      } else if (action === 'GetDiagnostics') {
        void this.eventBus.publish({
          eventType: 'command.GetDiagnostics',
          aggregateType: 'ChargingStation',
          aggregateId: stationId,
          payload: { request: payload, response },
        });
      }

      if (commandId != null) {
        await this.pubsub.publish(RESULTS_CHANNEL, JSON.stringify({ commandId, response }));
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Queue command for later delivery if station is offline
      if (errorMessage.includes('is not connected') && commandId != null) {
        this.logger.warn({ stationId, commandId, action }, 'Station offline, queuing command');
        void this.eventBus.publish({
          eventType: 'command.Queued',
          aggregateType: 'ChargingStation',
          aggregateId: stationId,
          payload: { commandId, stationId, action, payload, version },
        });
        await this.pubsub.publish(
          RESULTS_CHANNEL,
          JSON.stringify({ commandId, error: 'Station offline, command queued', queued: true }),
        );
        return;
      }

      this.logger.error({ stationId, action, error: errorMessage }, 'Command failed');

      // Log inbound CALLERROR from station
      void this.eventBus.publish({
        eventType: 'ocpp.MessageLog',
        aggregateType: 'ChargingStation',
        aggregateId: stationId,
        payload: {
          stationId,
          direction: 'inbound',
          messageType: MESSAGE_TYPE_CALLERROR,
          messageId,
          action,
          errorCode: 'InternalError',
          errorDescription: errorMessage,
        },
      });

      if (commandId != null) {
        await this.pubsub.publish(
          RESULTS_CHANNEL,
          JSON.stringify({ commandId, error: errorMessage }),
        );
      }
    }
  }

  async stop(): Promise<void> {
    if (this.subscription != null) {
      await this.subscription.unsubscribe();
      this.subscription = null;
    }
    this.logger.info('Command listener stopped');
  }
}
