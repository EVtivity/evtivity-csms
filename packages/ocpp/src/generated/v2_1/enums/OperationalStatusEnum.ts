export const OperationalStatusEnum = {
  Inoperative: 'Inoperative',
  Operative: 'Operative',
} as const;

export type OperationalStatusEnum = (typeof OperationalStatusEnum)[keyof typeof OperationalStatusEnum];
