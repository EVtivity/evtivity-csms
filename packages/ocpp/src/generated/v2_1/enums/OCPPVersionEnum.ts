export const OCPPVersionEnum = {
  OCPP12: 'OCPP12',
  OCPP15: 'OCPP15',
  OCPP16: 'OCPP16',
  OCPP20: 'OCPP20',
  OCPP201: 'OCPP201',
  OCPP21: 'OCPP21',
} as const;

export type OCPPVersionEnum = (typeof OCPPVersionEnum)[keyof typeof OCPPVersionEnum];
