export const StopTransactionReasonEnum = {
  EmergencyStop: 'EmergencyStop',
  EVDisconnected: 'EVDisconnected',
  HardReset: 'HardReset',
  Local: 'Local',
  Other: 'Other',
  PowerLoss: 'PowerLoss',
  Reboot: 'Reboot',
  Remote: 'Remote',
  SoftReset: 'SoftReset',
  UnlockCommand: 'UnlockCommand',
  DeAuthorized: 'DeAuthorized',
} as const;

export type StopTransactionReasonEnum = (typeof StopTransactionReasonEnum)[keyof typeof StopTransactionReasonEnum];
