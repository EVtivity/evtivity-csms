export const GridEventFaultEnum = {
  CurrentImbalance: 'CurrentImbalance',
  LocalEmergency: 'LocalEmergency',
  LowInputPower: 'LowInputPower',
  OverCurrent: 'OverCurrent',
  OverFrequency: 'OverFrequency',
  OverVoltage: 'OverVoltage',
  PhaseRotation: 'PhaseRotation',
  RemoteEmergency: 'RemoteEmergency',
  UnderFrequency: 'UnderFrequency',
  UnderVoltage: 'UnderVoltage',
  VoltageImbalance: 'VoltageImbalance',
} as const;

export type GridEventFaultEnum = (typeof GridEventFaultEnum)[keyof typeof GridEventFaultEnum];
