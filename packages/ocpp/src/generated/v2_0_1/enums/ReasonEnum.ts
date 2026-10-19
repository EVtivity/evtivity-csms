export const ReasonEnum = {
  DeAuthorized: 'DeAuthorized',
  EmergencyStop: 'EmergencyStop',
  EnergyLimitReached: 'EnergyLimitReached',
  EVDisconnected: 'EVDisconnected',
  GroundFault: 'GroundFault',
  ImmediateReset: 'ImmediateReset',
  Local: 'Local',
  LocalOutOfCredit: 'LocalOutOfCredit',
  MasterPass: 'MasterPass',
  Other: 'Other',
  OvercurrentFault: 'OvercurrentFault',
  PowerLoss: 'PowerLoss',
  PowerQuality: 'PowerQuality',
  Reboot: 'Reboot',
  Remote: 'Remote',
  SOCLimitReached: 'SOCLimitReached',
  StoppedByEV: 'StoppedByEV',
  TimeLimitReached: 'TimeLimitReached',
  Timeout: 'Timeout',
} as const;

export type ReasonEnum = (typeof ReasonEnum)[keyof typeof ReasonEnum];
