// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createInFlightTracker, createLogger } from '@evtivity/lib';
import type { PubSubClient, Subscription } from '@evtivity/lib';
import { drainListener, trackListenerWork } from '../lib/listener-drain.js';
import { initiateRegistration } from './credentials.service.js';
import type { OcpiVersion } from '../types/ocpi.js';

const logger = createLogger('ocpi-register-listener');
const CHANNEL = 'ocpi_register';

interface RegisterNotification {
  partnerId: string;
  versionUrl?: string;
  preferredVersion?: OcpiVersion;
}

function isRegisterNotification(payload: unknown): payload is RegisterNotification {
  if (payload == null || typeof payload !== 'object') return false;
  const obj = payload as Record<string, unknown>;
  return typeof obj['partnerId'] === 'string';
}

async function handleRegisterNotification(payload: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    logger.warn({ payload }, 'Invalid JSON on ocpi_register channel');
    return;
  }

  if (!isRegisterNotification(parsed)) {
    logger.warn({ payload }, 'Malformed ocpi_register notification (missing partnerId)');
    return;
  }

  const { partnerId, preferredVersion } = parsed;

  try {
    logger.info({ partnerId, preferredVersion }, 'Starting outbound OCPI registration');
    await initiateRegistration(partnerId, preferredVersion ?? '2.2.1');
    logger.info({ partnerId }, 'Outbound OCPI registration completed');
  } catch (err) {
    // Registration failure is logged but not rethrown — the worker channel
    // is fire-and-forget and the partner row keeps status='pending' so the
    // operator can retry from the UI after fixing the underlying problem.
    logger.error({ partnerId, err }, 'Outbound OCPI registration failed');
  }
}

export class OcpiRegisterListener {
  private readonly pubsub: PubSubClient;
  private subscription: Subscription | null = null;
  private readonly inFlight = createInFlightTracker();

  constructor(pubsub: PubSubClient) {
    this.pubsub = pubsub;
  }

  async start(): Promise<void> {
    this.subscription = await this.pubsub.subscribe(CHANNEL, (payload: string) => {
      trackListenerWork(this.inFlight, logger, () => handleRegisterNotification(payload));
    });
    logger.info({ channel: CHANNEL }, 'Listening for OCPI register notifications');
  }

  async stop(): Promise<void> {
    if (this.subscription != null) {
      await this.subscription.unsubscribe();
      this.subscription = null;
    }
    await drainListener(this.inFlight, logger);
    logger.info('OCPI register listener stopped');
  }
}
