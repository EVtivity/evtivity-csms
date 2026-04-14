export const RemoteStartTransactionChargingRateUnitEnum = {
  A: 'A',
  W: 'W',
} as const;

export type RemoteStartTransactionChargingRateUnitEnum = (typeof RemoteStartTransactionChargingRateUnitEnum)[keyof typeof RemoteStartTransactionChargingRateUnitEnum];
