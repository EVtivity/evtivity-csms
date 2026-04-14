export const MeterValuesLocationEnum = {
  Cable: 'Cable',
  EV: 'EV',
  Inlet: 'Inlet',
  Outlet: 'Outlet',
  Body: 'Body',
} as const;

export type MeterValuesLocationEnum = (typeof MeterValuesLocationEnum)[keyof typeof MeterValuesLocationEnum];
