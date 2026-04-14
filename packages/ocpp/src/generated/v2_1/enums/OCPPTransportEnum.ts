export const OCPPTransportEnum = {
  SOAP: 'SOAP',
  JSON: 'JSON',
} as const;

export type OCPPTransportEnum = (typeof OCPPTransportEnum)[keyof typeof OCPPTransportEnum];
