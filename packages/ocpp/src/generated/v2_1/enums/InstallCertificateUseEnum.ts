export const InstallCertificateUseEnum = {
  V2GRootCertificate: 'V2GRootCertificate',
  MORootCertificate: 'MORootCertificate',
  ManufacturerRootCertificate: 'ManufacturerRootCertificate',
  CSMSRootCertificate: 'CSMSRootCertificate',
  OEMRootCertificate: 'OEMRootCertificate',
} as const;

export type InstallCertificateUseEnum = (typeof InstallCertificateUseEnum)[keyof typeof InstallCertificateUseEnum];
