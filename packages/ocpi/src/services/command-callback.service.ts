// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { createLogger } from '@evtivity/lib';
import type { PubSubClient, Subscription } from '@evtivity/lib';
import { getOutboundToken } from '../lib/outbound-token.js';
import { config } from '../lib/config.js';
import type { OcpiCommandType, OcpiCommandResult, OcpiCommandResultType } from '../types/ocpi.js';

const logger = createLogger('ocpi-command-callback');
const RESULTS_CHANNEL = 'ocpp_command_results';
const COMMANDS_CHANNEL = 'ocpp_commands';
const COMMAND_TIMEOUT_MS = 30_000;
const CLEANUP_INTERVAL_MS = 10_000;

interface PendingCommand {
  responseUrl: string;
  partnerId: string;
  commandType: OcpiCommandType;
  registeredAt: number;
}

interface CommandResult {
  commandId: string;
  response?: Record<string, unknown>;
  error?: string;
}

function getCountryCode(): string {
  return config.OCPI_COUNTRY_CODE;
}

function getPartyId(): string {
  return config.OCPI_PARTY_ID;
}

function mapOcppResultToOcpi(
  commandType: OcpiCommandType,
  response: Record<string, unknown> | undefined,
  error: string | undefined,
): OcpiCommandResultType {
  if (error != null) {
    return 'FAILED';
  }

  if (response == null) {
    return 'FAILED';
  }

  // Map OCPP response status to OCPI command result
  const status = (response['status'] as string | undefined) ?? '';

  switch (commandType) {
    case 'START_SESSION': {
      if (status === 'Accepted') return 'ACCEPTED';
      return 'REJECTED';
    }
    case 'STOP_SESSION': {
      if (status === 'Accepted') return 'ACCEPTED';
      return 'REJECTED';
    }
    case 'RESERVE_NOW': {
      if (status === 'Accepted') return 'ACCEPTED';
      if (status === 'Occupied') return 'EVSE_OCCUPIED';
      if (status === 'Faulted') return 'EVSE_INOPERATIVE';
      if (status === 'Rejected') return 'REJECTED';
      return 'REJECTED';
    }
    case 'CANCEL_RESERVATION': {
      if (status === 'Accepted') return 'CANCELED_RESERVATION';
      if (status === 'Rejected') return 'UNKNOWN_RESERVATION';
      return 'REJECTED';
    }
    case 'UNLOCK_CONNECTOR': {
      if (status === 'Unlocked') return 'ACCEPTED';
      if (status === 'UnlockFailed') return 'FAILED';
      return 'REJECTED';
    }
    default:
      return 'FAILED';
  }
}

export class OcpiCommandCallbackService {
  private readonly pubsub: PubSubClient;
  private readonly pending = new Map<string, PendingCommand>();
  private subscription: Subscription | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(pubsub: PubSubClient) {
    this.pubsub = pubsub;
  }

  generateCommandId(): string {
    return crypto.randomUUID();
  }

  registerCommand(
    commandId: string,
    responseUrl: string,
    partnerId: string,
    commandType: OcpiCommandType,
  ): void {
    this.pending.set(commandId, {
      responseUrl,
      partnerId,
      commandType,
      registeredAt: Date.now(),
    });
  }

  async dispatchOcppCommand(
    commandId: string,
    stationId: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const notification = JSON.stringify({ commandId, stationId, action, payload });
    await this.pubsub.publish(COMMANDS_CHANNEL, notification);
    logger.info({ commandId, stationId, action }, 'Dispatched OCPP command');
  }

  async start(): Promise<void> {
    this.subscription = await this.pubsub.subscribe(RESULTS_CHANNEL, (payload: string) => {
      void this.handleResult(payload);
    });

    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, CLEANUP_INTERVAL_MS);

    logger.info({ channel: RESULTS_CHANNEL }, 'Listening for OCPP command results');
  }

  private async handleResult(raw: string): Promise<void> {
    let result: CommandResult;
    try {
      result = JSON.parse(raw) as CommandResult;
    } catch {
      logger.error({ raw }, 'Invalid command result payload');
      return;
    }

    const { commandId } = result;
    const pending = this.pending.get(commandId);
    if (pending == null) {
      // Not one of our OCPI-initiated commands
      return;
    }

    this.pending.delete(commandId);

    const ocpiResult = mapOcppResultToOcpi(pending.commandType, result.response, result.error);
    const commandResult: OcpiCommandResult = { result: ocpiResult };

    logger.info(
      { commandId, commandType: pending.commandType, result: ocpiResult },
      'Sending command result to partner',
    );

    await this.postCommandResult(pending.responseUrl, pending.partnerId, commandResult);
  }

  private async postCommandResult(
    responseUrl: string,
    partnerId: string,
    commandResult: OcpiCommandResult,
  ): Promise<void> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'OCPI-from-country-code': getCountryCode(),
        'OCPI-from-party-id': getPartyId(),
      };

      const token = await getOutboundToken(partnerId);
      if (token != null) {
        const tokenBase64 = Buffer.from(token).toString('base64');
        headers['Authorization'] = `Token ${tokenBase64}`;
      } else {
        logger.warn({ partnerId }, 'No outbound token for partner callback');
      }

      const response = await fetch(responseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(commandResult),
      });

      if (!response.ok) {
        logger.warn(
          { responseUrl, status: response.status },
          'Partner rejected command result callback',
        );
      }
    } catch (err) {
      logger.error({ responseUrl, err }, 'Failed to POST command result to partner');
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [commandId, pending] of this.pending) {
      if (now - pending.registeredAt > COMMAND_TIMEOUT_MS) {
        this.pending.delete(commandId);

        // Send TIMEOUT result to partner
        const commandResult: OcpiCommandResult = { result: 'TIMEOUT' };
        logger.warn({ commandId, commandType: pending.commandType }, 'Command timed out');
        void this.postCommandResult(pending.responseUrl, pending.partnerId, commandResult);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer != null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.subscription != null) {
      await this.subscription.unsubscribe();
      this.subscription = null;
    }
    logger.info('Command callback service stopped');
  }
}

// Singleton for use across routes
let instance: OcpiCommandCallbackService | null = null;

export function getCommandCallbackService(): OcpiCommandCallbackService {
  if (instance == null) {
    throw new Error('Command callback service not initialized');
  }
  return instance;
}

export function initCommandCallbackService(pubsub: PubSubClient): OcpiCommandCallbackService {
  instance = new OcpiCommandCallbackService(pubsub);
  return instance;
}
