export const GetInstalledCertificateIdsHashAlgorithmEnum = {
  SHA256: 'SHA256',
  SHA384: 'SHA384',
  SHA512: 'SHA512',
} as const;

export type GetInstalledCertificateIdsHashAlgorithmEnum = (typeof GetInstalledCertificateIdsHashAlgorithmEnum)[keyof typeof GetInstalledCertificateIdsHashAlgorithmEnum];
