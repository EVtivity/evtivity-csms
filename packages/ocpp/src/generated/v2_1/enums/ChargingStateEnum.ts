export const ChargingStateEnum = {
  EVConnected: 'EVConnected',
  Charging: 'Charging',
  SuspendedEV: 'SuspendedEV',
  SuspendedEVSE: 'SuspendedEVSE',
  Idle: 'Idle',
} as const;

export type ChargingStateEnum = (typeof ChargingStateEnum)[keyof typeof ChargingStateEnum];
