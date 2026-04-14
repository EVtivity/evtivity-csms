export const RemoteStartTransactionChargingProfilePurposeEnum = {
  ChargePointMaxProfile: 'ChargePointMaxProfile',
  TxDefaultProfile: 'TxDefaultProfile',
  TxProfile: 'TxProfile',
} as const;

export type RemoteStartTransactionChargingProfilePurposeEnum = (typeof RemoteStartTransactionChargingProfilePurposeEnum)[keyof typeof RemoteStartTransactionChargingProfilePurposeEnum];
