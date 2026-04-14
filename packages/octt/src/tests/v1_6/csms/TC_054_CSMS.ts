// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_054_CSMS: TestCase = {
  id: 'TC_054_CSMS',
  name: 'Trigger Message (1.6)',
  module: 'remote-trigger',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The Central System triggers multiple message types from the Charge Point.',
  purpose: 'Verify the CSMS can send TriggerMessage for various requestedMessage types.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });
    await ctx.client.sendCall('StatusNotification', {
      connectorId: 1,
      status: 'Available',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });

    const triggers: Array<{
      requestedMessage: string;
      connectorId?: number;
      expectStatus: string;
    }> = [
      { requestedMessage: 'MeterValues', connectorId: 1, expectStatus: 'Accepted' },
      { requestedMessage: 'Heartbeat', expectStatus: 'Accepted' },
      { requestedMessage: 'StatusNotification', connectorId: 1, expectStatus: 'Accepted' },
      { requestedMessage: 'DiagnosticsStatusNotification', expectStatus: 'Accepted' },
      { requestedMessage: 'FirmwareStatusNotification', expectStatus: 'Accepted' },
    ];

    for (let i = 0; i < triggers.length; i++) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- index always in bounds
      const trigger = triggers[i]!;
      let receivedMessage = '';
      let received = false;

      ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
        if (action === 'TriggerMessage') {
          received = true;
          receivedMessage = (payload['requestedMessage'] as string) || '';
          return { status: trigger.expectStatus };
        }
        return {};
      });

      if (ctx.triggerCommand != null) {
        const triggerPayload: Record<string, unknown> = {
          stationId: ctx.stationId,
          requestedMessage: trigger.requestedMessage,
        };
        if (trigger.connectorId != null) {
          triggerPayload['connectorId'] = trigger.connectorId;
        }
        await ctx.triggerCommand('v16', 'TriggerMessage', triggerPayload);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      steps.push({
        step: i + 1,
        description: `TriggerMessage ${trigger.requestedMessage} received and responded ${trigger.expectStatus}`,
        status: received && receivedMessage === trigger.requestedMessage ? 'passed' : 'failed',
        expected: `TriggerMessage.req with requestedMessage=${trigger.requestedMessage}`,
        actual: received
          ? `Received requestedMessage=${receivedMessage}, responded ${trigger.expectStatus}`
          : 'Not received',
      });

      // Send the corresponding notification after accepting the trigger
      if (received) {
        if (trigger.requestedMessage === 'MeterValues') {
          await ctx.client.sendCall('MeterValues', {
            connectorId: 1,
            meterValue: [
              {
                timestamp: new Date().toISOString(),
                sampledValue: [{ value: '0', measurand: 'Energy.Active.Import.Register' }],
              },
            ],
          });
        } else if (trigger.requestedMessage === 'Heartbeat') {
          await ctx.client.sendCall('Heartbeat', {});
        } else if (trigger.requestedMessage === 'StatusNotification') {
          await ctx.client.sendCall('StatusNotification', {
            connectorId: 1,
            status: 'Available',
            errorCode: 'NoError',
            timestamp: new Date().toISOString(),
          });
        } else if (trigger.requestedMessage === 'DiagnosticsStatusNotification') {
          await ctx.client.sendCall('DiagnosticsStatusNotification', { status: 'Idle' });
        } else if (trigger.requestedMessage === 'FirmwareStatusNotification') {
          await ctx.client.sendCall('FirmwareStatusNotification', { status: 'Idle' });
        }
      }
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
