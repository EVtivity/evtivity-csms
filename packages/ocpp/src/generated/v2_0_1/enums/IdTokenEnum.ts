export const IdTokenEnum = {
  Central: 'Central',
  eMAID: 'eMAID',
  ISO14443: 'ISO14443',
  ISO15693: 'ISO15693',
  KeyCode: 'KeyCode',
  Local: 'Local',
  MacAddress: 'MacAddress',
  NoAuthorization: 'NoAuthorization',
} as const;

export type IdTokenEnum = (typeof IdTokenEnum)[keyof typeof IdTokenEnum];
