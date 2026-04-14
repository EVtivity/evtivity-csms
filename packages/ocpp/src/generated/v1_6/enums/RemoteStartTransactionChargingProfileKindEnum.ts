export const RemoteStartTransactionChargingProfileKindEnum = {
  Absolute: 'Absolute',
  Recurring: 'Recurring',
  Relative: 'Relative',
} as const;

export type RemoteStartTransactionChargingProfileKindEnum = (typeof RemoteStartTransactionChargingProfileKindEnum)[keyof typeof RemoteStartTransactionChargingProfileKindEnum];
