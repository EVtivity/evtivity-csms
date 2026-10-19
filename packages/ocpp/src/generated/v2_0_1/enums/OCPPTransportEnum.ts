export const OCPPTransportEnum = {
  JSON: 'JSON',
  SOAP: 'SOAP',
} as const;

export type OCPPTransportEnum = (typeof OCPPTransportEnum)[keyof typeof OCPPTransportEnum];
