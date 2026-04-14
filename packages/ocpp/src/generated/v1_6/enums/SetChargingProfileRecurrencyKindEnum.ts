export const SetChargingProfileRecurrencyKindEnum = {
  Daily: 'Daily',
  Weekly: 'Weekly',
} as const;

export type SetChargingProfileRecurrencyKindEnum = (typeof SetChargingProfileRecurrencyKindEnum)[keyof typeof SetChargingProfileRecurrencyKindEnum];
