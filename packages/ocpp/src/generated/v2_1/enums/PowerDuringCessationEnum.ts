export const PowerDuringCessationEnum = {
  Active: 'Active',
  Reactive: 'Reactive',
} as const;

export type PowerDuringCessationEnum = (typeof PowerDuringCessationEnum)[keyof typeof PowerDuringCessationEnum];
