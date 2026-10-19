export const GetInstalledCertificateStatusEnum = {
  Accepted: 'Accepted',
  NotFound: 'NotFound',
} as const;

export type GetInstalledCertificateStatusEnum = (typeof GetInstalledCertificateStatusEnum)[keyof typeof GetInstalledCertificateStatusEnum];
