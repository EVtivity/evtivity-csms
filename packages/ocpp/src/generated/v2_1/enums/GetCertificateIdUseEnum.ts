export const GetCertificateIdUseEnum = {
  V2GRootCertificate: 'V2GRootCertificate',
  MORootCertificate: 'MORootCertificate',
  CSMSRootCertificate: 'CSMSRootCertificate',
  V2GCertificateChain: 'V2GCertificateChain',
  ManufacturerRootCertificate: 'ManufacturerRootCertificate',
  OEMRootCertificate: 'OEMRootCertificate',
} as const;

export type GetCertificateIdUseEnum = (typeof GetCertificateIdUseEnum)[keyof typeof GetCertificateIdUseEnum];
