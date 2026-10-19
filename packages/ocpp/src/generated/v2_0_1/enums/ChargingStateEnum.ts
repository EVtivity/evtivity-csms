export const ChargingStateEnum = {
  Charging: 'Charging',
  EVConnected: 'EVConnected',
  SuspendedEV: 'SuspendedEV',
  SuspendedEVSE: 'SuspendedEVSE',
  Idle: 'Idle',
} as const;

export type ChargingStateEnum = (typeof ChargingStateEnum)[keyof typeof ChargingStateEnum];
