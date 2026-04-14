export const EvseKindEnum = {
  AC: 'AC',
  DC: 'DC',
} as const;

export type EvseKindEnum = (typeof EvseKindEnum)[keyof typeof EvseKindEnum];
