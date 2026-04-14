// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';

interface ReportDataEntry {
  component?: { name?: string };
  variable?: { name?: string };
  variableAttribute?: { value?: string }[];
}

function findVariableValue(
  reportData: unknown[],
  componentName: string,
  variableName: string,
): string | null {
  for (const entry of reportData) {
    const item = entry as ReportDataEntry;
    if (item.component?.name === componentName && item.variable?.name === variableName) {
      return item.variableAttribute?.[0]?.value ?? null;
    }
  }
  return null;
}

export async function handleNotifyReport(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const request = ctx.payload as {
    requestId: number;
    generatedAt: string;
    seqNo: number;
    tbc?: boolean;
    reportData?: unknown[];
  };

  ctx.logger.info(
    {
      stationId: ctx.stationId,
      requestId: request.requestId,
      seqNo: request.seqNo,
      reportCount: request.reportData?.length ?? 0,
    },
    'NotifyReport received',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.NotifyReport',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      requestId: request.requestId,
      generatedAt: request.generatedAt,
      seqNo: request.seqNo,
      tbc: request.tbc,
      reportData: request.reportData,
    },
  });

  // OCPP 2.1 K01.FR.80: when station reports MaxExternalConstraintsId, send SetChargingProfile
  // using that ID so the station knows which profile ID to expect for external constraints.
  if (request.reportData != null && request.reportData.length > 0) {
    const maxIdStr = findVariableValue(
      request.reportData,
      'SmartChargingCtrlr',
      'MaxExternalConstraintsId',
    );
    if (maxIdStr != null) {
      const profileId = parseInt(maxIdStr, 10);
      if (!isNaN(profileId)) {
        ctx.logger.info(
          { stationId: ctx.stationId, profileId },
          'MaxExternalConstraintsId received, sending SetChargingProfile',
        );
        try {
          await ctx.dispatcher.sendCommand(ctx.stationId, 'SetChargingProfile', {
            evseId: 0,
            chargingProfile: {
              id: profileId,
              stackLevel: 0,
              chargingProfilePurpose: 'ChargingStationExternalConstraints',
              chargingProfileKind: 'Absolute',
              chargingSchedule: [
                {
                  id: 1,
                  chargingRateUnit: 'W',
                  chargingSchedulePeriod: [{ startPeriod: 0, limit: 0.0 }],
                },
              ],
            },
          });
        } catch (err) {
          ctx.logger.warn(
            { err, stationId: ctx.stationId },
            'Failed to send SetChargingProfile for MaxExternalConstraintsId',
          );
        }
      }
    }
  }

  return {};
}
