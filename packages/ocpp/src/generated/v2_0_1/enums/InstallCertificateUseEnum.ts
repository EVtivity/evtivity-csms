export const InstallCertificateUseEnum = {
  V2GRootCertificate: 'V2GRootCertificate',
  MORootCertificate: 'MORootCertificate',
  CSMSRootCertificate: 'CSMSRootCertificate',
  ManufacturerRootCertificate: 'ManufacturerRootCertificate',
} as const;

export type InstallCertificateUseEnum = (typeof InstallCertificateUseEnum)[keyof typeof InstallCertificateUseEnum];
