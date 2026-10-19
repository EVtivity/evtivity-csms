export const LocationEnum = {
  Body: 'Body',
  Cable: 'Cable',
  EV: 'EV',
  Inlet: 'Inlet',
  Outlet: 'Outlet',
} as const;

export type LocationEnum = (typeof LocationEnum)[keyof typeof LocationEnum];
