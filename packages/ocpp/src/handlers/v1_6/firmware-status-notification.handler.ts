// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { HandlerContext } from '../../server/middleware/pipeline.js';
import type { FirmwareStatusNotification } from '../../generated/v1_6/types/messages/FirmwareStatusNotification.js';

const FIRMWARE_STATUS_MAP: Record<string, string> = {
  Downloaded: 'Downloaded',
  DownloadFailed: 'DownloadFailed',
  Downloading: 'Downloading',
  Idle: 'Idle',
  InstallationFailed: 'InstallationFailed',
  Installing: 'Installing',
  Installed: 'Installed',
};

export async function handleFirmwareStatusNotification(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as unknown as FirmwareStatusNotification;
  const mappedStatus = FIRMWARE_STATUS_MAP[request.status] ?? request.status;

  ctx.logger.info(
    { stationId: ctx.stationId, status: request.status },
    'FirmwareStatusNotification received (1.6)',
  );

  await ctx.eventBus.publish({
    eventType: 'ocpp.FirmwareStatusNotification',
    aggregateType: 'ChargingStation',
    aggregateId: ctx.stationId,
    payload: {
      stationId: ctx.stationId,
      status: mappedStatus,
    },
  });

  return {};
}
