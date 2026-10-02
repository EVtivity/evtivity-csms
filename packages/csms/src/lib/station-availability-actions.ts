// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export interface StationAvailabilityInputs {
  disabledReason: string | null;
  firmwareState: string | null;
  reportedStatus: string | null;
}

export interface StationAvailabilityActions {
  enable: boolean;
  disable: boolean;
}

// Which of Enable / Disable the station header offers. A disabled station
// (operator or security) can only be enabled. Any other station can be
// disabled, and can also be enabled when a firmware install state is stored or
// the station reports itself unavailable, so the operator can send Operative
// again and clear the firmware state.
export function stationAvailabilityActions(
  station: StationAvailabilityInputs,
): StationAvailabilityActions {
  if (station.disabledReason != null) return { enable: true, disable: false };
  return {
    enable: station.firmwareState != null || station.reportedStatus === 'unavailable',
    disable: true,
  };
}
