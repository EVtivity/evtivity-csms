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
import { OCPP_COMMANDS_CHANNEL, OCPP_COMMAND_RESULTS_CHANNEL, tryParseJson } from '@evtivity/lib';
import type { CommandDispatcher } from './command-dispatcher.js';
import { CommandTimeoutError } from './message-correlator.js';
import { publishMessageLog } from './message-log.js';
import { holdsStationCredential, maskStationCredentials } from '@evtivity/lib/secret-config';
import {
  MESSAGE_TYPE_CALL,
  MESSAGE_TYPE_CALLRESULT,
  MESSAGE_TYPE_CALLERROR,
} from '../protocol/message-types.js';

const CHANNEL = OCPP_COMMANDS_CHANNEL;

const RESULTS_CHANNEL = OCPP_COMMAND_RESULTS_CHANNEL;

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
    const parsed = tryParseJson(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      // The raw text can hold a station password: log its size only.
      this.logger.error({ rawLength: raw.length }, 'Invalid command payload from event source');
      return;
    }
    const command = parsed as CommandPayload;

    if (
      typeof command.stationId !== 'string' ||
      typeof command.action !== 'string' ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime check for untrusted JSON
      command.payload == null
    ) {
      this.logger.error(
        { command: maskStationCredentials(command) },
        'Malformed command payload: missing required fields',
      );
      return;
    }

    if (command.commandId != null && typeof command.commandId !== 'string') {
      this.logger.error(
        { command: maskStationCredentials(command) },
        'Malformed command payload: commandId must be a string',
      );
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
      } catch (err) {
        this.logger.debug(
          { err, stationId, instanceId: this.instanceId },
          'Connection registry lookup failed; proceeding with dispatch (fail-open)',
        );
      }
    }

    // Log outbound CALL to station
    const messageId = commandId ?? crypto.randomUUID();
    publishMessageLog(this.eventBus, {
      stationId,
      direction: 'outbound',
      messageType: MESSAGE_TYPE_CALL,
      messageId,
      action,
      payload,
    });

    try {
      // When version is present, the frontend sent a version-native payload -- dispatch directly.
      // When absent, use version-aware translation for programmatic callers (reservations, etc.).
      // Sent once, never retried: the caller waits about 35 s for the result,
      // and a resend after a timeout would reach the station after the caller
      // gave up (a CommandTimeoutError goes back as timedOut).
      const response =
        version != null
          ? await this.dispatcher.sendCommand(stationId, action, payload)
          : await this.dispatcher.sendVersionAwareCommand(stationId, action, payload);
      this.logger.info(
        { stationId, action, response: maskStationCredentials(response) },
        'Command completed',
      );

      // Log inbound CALLRESULT from station
      publishMessageLog(this.eventBus, {
        stationId,
        direction: 'inbound',
        messageType: MESSAGE_TYPE_CALLRESULT,
        messageId,
        action,
        payload: response,
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
        // Persisted in domain_events: a credential a station returns is masked.
        void this.eventBus.publish({
          eventType: 'command.GetVariables',
          aggregateType: 'ChargingStation',
          aggregateId: stationId,
          payload: maskStationCredentials({ request: payload, response }),
        });
      } else if (action === 'GetConfiguration') {
        void this.eventBus.publish({
          eventType: 'command.GetConfiguration',
          aggregateType: 'ChargingStation',
          aggregateId: stationId,
          payload: maskStationCredentials({ request: payload, response }),
        });
      } else if (action === 'UpdateFirmware' || action === 'SignedUpdateFirmware') {
        // 1.6 SignedUpdateFirmware has the 2.1 UpdateFirmware payload shape.
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
      } else if (action === 'ReserveNow') {
        // Worker handler dispatches scheduled reservations fire-and-forget.
        // Publish the result so the projection can roll back the reservation
        // when the station replies with a non-Accepted status (e.g. Occupied
        // because the EVSE is in a charging session at activation time).
        void this.eventBus.publish({
          eventType: 'command.ReserveNow',
          aggregateType: 'ChargingStation',
          aggregateId: stationId,
          payload: { request: payload, response },
        });
      } else if (action === 'ClearChargingProfile') {
        // The projection removes the stored copies of the cleared profiles,
        // for every caller (station route, template push, AI, OCPP command
        // routes, a clear queued while the station was offline).
        void this.eventBus.publish({
          eventType: 'command.ClearChargingProfile',
          aggregateType: 'ChargingStation',
          aggregateId: stationId,
          payload: { request: payload, response },
        });
      } else if (action === 'GetChargingProfiles') {
        // The projection drops stored station profiles the station no longer
        // reports (NoProfiles, or an EVSE that sends no report this time).
        void this.eventBus.publish({
          eventType: 'command.GetChargingProfiles',
          aggregateType: 'ChargingStation',
          aggregateId: stationId,
          payload: { request: payload, response },
        });
      } else if (action === 'SetDisplayMessage' || action === 'ClearDisplayMessage') {
        // A display message command queued for an offline station is sent on
        // reconnect with no API caller waiting: the projection records the reply.
        void this.eventBus.publish({
          eventType: `command.${action}`,
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
      // A station credential change is never queued: the queue row and its
      // domain event would hold the password, and a late delivery would set a
      // password the stored hash no longer matches (lockout).
      if (errorMessage.includes('is not connected') && holdsStationCredential(payload)) {
        this.logger.warn(
          { stationId, commandId, action },
          'Station offline, credential change not queued',
        );
        if (commandId != null) {
          await this.pubsub.publish(
            RESULTS_CHANNEL,
            JSON.stringify({
              commandId,
              error: 'Station offline, a station credential change is not queued',
            }),
          );
        }
        return;
      }

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
      publishMessageLog(this.eventBus, {
        stationId,
        direction: 'inbound',
        messageType: MESSAGE_TYPE_CALLERROR,
        messageId,
        action,
        errorCode: 'InternalError',
        errorDescription: errorMessage,
      });

      const timedOut = err instanceof CommandTimeoutError;
      // A firmware update the station answered with an error, or that could not
      // be sent, never starts: the projection ends it so its campaign can
      // complete. A timeout stays open, the station may still report it.
      if ((action === 'UpdateFirmware' || action === 'SignedUpdateFirmware') && !timedOut) {
        void this.eventBus.publish({
          eventType: 'command.UpdateFirmware',
          aggregateType: 'ChargingStation',
          aggregateId: stationId,
          payload: { request: payload, error: errorMessage },
        });
      }

      if (commandId != null) {
        // timedOut tells the caller the station did not answer (504), as
        // opposed to a send error or CALLERROR (502).
        await this.pubsub.publish(
          RESULTS_CHANNEL,
          JSON.stringify(
            timedOut
              ? { commandId, error: errorMessage, timedOut }
              : { commandId, error: errorMessage },
          ),
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
