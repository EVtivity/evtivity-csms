// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from 'pino';
import { db, chargingStations } from '@evtivity/database';
import { createId } from '@evtivity/database/src/lib/id.js';
import { hash } from 'argon2';
import type { TestCase, TestCaseResult, RunConfig, TriggerCommandFn, CallApiFn } from './types.js';
import { createTestClient, generateStationId } from './client.js';
import { generateTestTokens, provisionTestTokens } from './test-tokens.js';
import { stopOpenTransactions } from './transaction-teardown.js';
import { defaultReply } from './default-replies.js';
import type { OcspTestService } from './ocsp-test-service.js';

export async function executeTest(
  testCase: TestCase,
  config: RunConfig,
  logger: Logger,
  triggerCommand?: TriggerCommandFn,
  callApi?: CallApiFn,
  testDriverId?: string,
  ocsp?: OcspTestService,
): Promise<TestCaseResult> {
  const stationId = generateStationId(testCase.module, testCase.id);
  const provisionStations = config.provisionStations ?? true;

  // Register the station before connecting so the CSMS accepts the connection (SP0
  // unless the test asks for another profile), then remove it after the test completes.
  const provision = testCase.provision ?? { securityProfile: 0 };
  const stationDbId = provisionStations ? createId('station') : null;
  if (provisionStations && stationDbId != null) {
    await db
      .insert(chargingStations)
      .values({
        id: stationDbId,
        stationId,
        securityProfile: provision.securityProfile,
        ...(provision.password != null
          ? { basicAuthPasswordHash: await hash(provision.password) }
          : {}),
        availability: 'available',
        onboardingStatus: testCase.onboardingStatus ?? 'accepted',
      })
      .onConflictDoNothing({ target: chargingStations.stationId });
  }

  // Per-test tokens, so tests never share an idToken (a token with a running
  // transaction elsewhere is answered ConcurrentTx).
  const tokens = generateTestTokens();
  if (provisionStations && testDriverId != null) {
    await provisionTestTokens(testDriverId, tokens);
  }

  const client = createTestClient({
    serverUrl: config.serverUrl,
    stationId,
    version: testCase.version,
    password: provision.password ?? config.password,
    securityProfile: provisionStations ? provision.securityProfile : undefined,
    caCert: config.tlsCaCert,
  });

  const log = logger.child({ testId: testCase.id, stationId });
  const start = Date.now();

  try {
    // Suppress OcppClient console.log noise for connect/disconnect
    client.setConnectedHandler(() => {});
    client.setDisconnectedHandler(() => {
      client.disconnect();
    });

    await client.connect();

    // CSMS calls the test does not handle get a schema-valid default reply.
    // Tests that set their own handler fall back to the same replies.
    client.setIncomingCallHandler((_messageId, action, payload) =>
      defaultReply(testCase.version, action, payload),
    );

    log.debug('Connected, executing test');

    const result = await testCase.execute({
      client,
      stationId,
      tokens,
      stationDbId,
      logger: log,
      config,
      triggerCommand,
      callApi,
      ocsp,
      testDriverId: provisionStations ? testDriverId : undefined,
    });

    result.durationMs = Date.now() - start;
    log.debug({ status: result.status, durationMs: result.durationMs }, 'Test completed');

    return {
      testId: testCase.id,
      testName: testCase.name,
      module: testCase.module,
      version: testCase.version,
      result,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ error: errorMessage, durationMs }, 'Test errored');

    return {
      testId: testCase.id,
      testName: testCase.name,
      module: testCase.module,
      version: testCase.version,
      result: {
        status: 'error',
        durationMs,
        steps: [],
        error: errorMessage,
      },
    };
  } finally {
    // OCTT test procedure 8.2: stop any transaction still running so the next
    // test starts from an idle station.
    await stopOpenTransactions({
      client,
      stationId,
      stationDbId,
      version: testCase.version,
      logger: log,
    });
    client.disconnect();
    // Station cleanup is deferred to run end (see runTests) to avoid racing the
    // OCPP server's async projections.
  }
}
