export const StopTransactionLocationEnum = {
  Cable: 'Cable',
  EV: 'EV',
  Inlet: 'Inlet',
  Outlet: 'Outlet',
  Body: 'Body',
} as const;

export type StopTransactionLocationEnum = (typeof StopTransactionLocationEnum)[keyof typeof StopTransactionLocationEnum];
