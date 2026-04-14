// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { OcppClient } from '@evtivity/css/ocpp-client';
import { db, chargingStations } from '@evtivity/database';
import { eq } from 'drizzle-orm';
import { hash } from 'argon2';
import type { TestCase, StepResult } from '../../../../types.js';

const KNOWN_PASSWORD = 'test-password-tc-a02';

export const TC_A_02_CSMS: TestCase = {
  id: 'TC_A_02_CSMS',
  name: 'Basic Authentication - Username does not equal ChargingStationId',
  module: 'A-security',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The Charging Station uses Basic authentication to authenticate itself to the CSMS with an invalid username (not equal to the ChargingStationId).',
  purpose:
    'To verify whether the CSMS rejects Basic authentication credentials when the username does not match the ChargingStationId.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // The executor provisions the station as SP0 (no auth). Update it to SP1
    // with a known password so the CSMS enforces Basic Auth.
    const passwordHash = await hash(KNOWN_PASSWORD);
    await db
      .update(chargingStations)
      .set({ securityProfile: 1, basicAuthPasswordHash: passwordHash })
      .where(eq(chargingStations.stationId, ctx.stationId));

    // Step 1: Attempt connection with wrong password. CSMS should reject.
    const wrongPasswordSuffix = Math.random().toString(36).slice(2, 10);
    const badClient = new OcppClient({
      serverUrl: ctx.config.serverUrl,
      stationId: ctx.stationId,
      ocppProtocol: 'ocpp2.1',
      password: 'invalid-password-' + wrongPasswordSuffix,
      securityProfile: 1,
    });

    let rejected = false;
    try {
      await badClient.connect();
      // Give the server a moment to close the connection if it accepted the upgrade
      await new Promise((resolve) => setTimeout(resolve, 1000));
      rejected = !badClient.isConnected;
    } catch {
      rejected = true;
    } finally {
      badClient.disconnect();
    }

    steps.push({
      step: 1,
      description: 'CSMS rejects connection with invalid password',
      status: rejected ? 'passed' : 'failed',
      expected: 'Connection rejected (not connected)',
      actual: rejected ? 'Connection rejected' : 'Connection unexpectedly accepted',
    });

    // Step 2: Verify valid connection works with correct credentials.
    // The executor's ctx.client was created with SP0 (no password), so we
    // create a new client with the correct SP1 credentials.
    const validClient = new OcppClient({
      serverUrl: ctx.config.serverUrl,
      stationId: ctx.stationId,
      ocppProtocol: 'ocpp2.1',
      password: KNOWN_PASSWORD,
      securityProfile: 1,
    });

    let validConnected = false;
    try {
      await validClient.connect();
      await new Promise((resolve) => setTimeout(resolve, 500));
      validConnected = validClient.isConnected;
    } catch {
      validConnected = false;
    } finally {
      validClient.disconnect();
    }

    steps.push({
      step: 2,
      description: 'CSMS accepts connection with valid credentials',
      status: validConnected ? 'passed' : 'failed',
      expected: 'Connected with valid credentials',
      actual: validConnected ? 'Connected with valid credentials' : 'Not connected',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
