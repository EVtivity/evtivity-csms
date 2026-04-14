export const InstallCertificateCertificateTypeEnum = {
  CentralSystemRootCertificate: 'CentralSystemRootCertificate',
  ManufacturerRootCertificate: 'ManufacturerRootCertificate',
} as const;

export type InstallCertificateCertificateTypeEnum = (typeof InstallCertificateCertificateTypeEnum)[keyof typeof InstallCertificateCertificateTypeEnum];
