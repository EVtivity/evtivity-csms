// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from 'pino';
import { db, chargingStations } from '@evtivity/database';
import { eq } from 'drizzle-orm';
import { createId } from '@evtivity/database/src/lib/id.js';
import type { TestCase, TestCaseResult, RunConfig, TriggerCommandFn } from './types.js';
import { createTestClient, generateStationId } from './client.js';

export async function executeTest(
  testCase: TestCase,
  config: RunConfig,
  logger: Logger,
  triggerCommand?: TriggerCommandFn,
): Promise<TestCaseResult> {
  const stationId = generateStationId(testCase.module, testCase.id);
  const provisionStations = config.provisionStations ?? true;

  // Register the station as SP0 before connecting so the CSMS accepts the connection,
  // then remove it after the test completes.
  if (provisionStations) {
    await db
      .insert(chargingStations)
      .values({
        id: createId('station'),
        stationId,
        securityProfile: 0,
        availability: 'available',
        onboardingStatus: testCase.onboardingStatus ?? 'accepted',
      })
      .onConflictDoNothing({ target: chargingStations.stationId });
  }

  const client = createTestClient({
    serverUrl: config.serverUrl,
    stationId,
    version: testCase.version,
    password: config.password,
    securityProfile: provisionStations ? 0 : undefined,
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

    // Default handler accepts common CSMS-initiated calls (SetVariables, GetVariables, etc.)
    // so they don't produce noisy "NotSupported" warnings. Tests override this when they
    // need to validate specific incoming commands.
    client.setIncomingCallHandler(
      (_messageId: string, action: string): Promise<Record<string, unknown>> => {
        const responses: Record<string, Record<string, unknown>> = {
          // OCPP 2.1
          SetVariables: {
            setVariableResult: [{ attributeStatus: 'Accepted', component: {}, variable: {} }],
          },
          GetVariables: {
            getVariableResult: [
              { attributeStatus: 'UnknownComponent', component: {}, variable: {} },
            ],
          },
          RequestStartTransaction: { status: 'Rejected' },
          RequestStopTransaction: { status: 'Accepted' },
          SetNetworkProfile: { status: 'Accepted' },
          SetMonitoringBase: { status: 'Accepted' },
          ClearVariableMonitoring: { clearMonitoringResult: [{ status: 'Accepted' }] },
          // OCPP 1.6
          ChangeConfiguration: { status: 'Accepted' },
          GetConfiguration: { configurationKey: [], unknownKey: [] },
          RemoteStartTransaction: { status: 'Rejected' },
          RemoteStopTransaction: { status: 'Accepted' },
        };
        return Promise.resolve(responses[action] ?? { status: 'NotSupported' });
      },
    );

    log.debug('Connected, executing test');

    const result = await testCase.execute({
      client,
      stationId,
      logger: log,
      config,
      triggerCommand,
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
    client.disconnect();
    if (provisionStations) {
      const station = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.stationId, stationId))
        .limit(1);
      const stationDbId = station[0]?.id;
      if (stationDbId != null) {
        await db.delete(chargingStations).where(eq(chargingStations.id, stationDbId));
      }
    }
  }
}
