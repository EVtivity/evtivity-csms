export const GetInstalledCertificateIdsStatusEnum = {
  Accepted: 'Accepted',
  NotFound: 'NotFound',
} as const;

export type GetInstalledCertificateIdsStatusEnum = (typeof GetInstalledCertificateIdsStatusEnum)[keyof typeof GetInstalledCertificateIdsStatusEnum];
