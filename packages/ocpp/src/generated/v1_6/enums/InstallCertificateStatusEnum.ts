export const InstallCertificateStatusEnum = {
  Accepted: 'Accepted',
  Failed: 'Failed',
  Rejected: 'Rejected',
} as const;

export type InstallCertificateStatusEnum = (typeof InstallCertificateStatusEnum)[keyof typeof InstallCertificateStatusEnum];
