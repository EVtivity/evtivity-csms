export const GetInstalledCertificateIdsCertificateTypeEnum = {
  CentralSystemRootCertificate: 'CentralSystemRootCertificate',
  ManufacturerRootCertificate: 'ManufacturerRootCertificate',
} as const;

export type GetInstalledCertificateIdsCertificateTypeEnum = (typeof GetInstalledCertificateIdsCertificateTypeEnum)[keyof typeof GetInstalledCertificateIdsCertificateTypeEnum];
