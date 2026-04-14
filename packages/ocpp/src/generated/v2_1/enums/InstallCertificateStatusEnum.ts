export const InstallCertificateStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  Failed: 'Failed',
} as const;

export type InstallCertificateStatusEnum = (typeof InstallCertificateStatusEnum)[keyof typeof InstallCertificateStatusEnum];
