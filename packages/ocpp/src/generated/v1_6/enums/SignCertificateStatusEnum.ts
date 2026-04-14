export const SignCertificateStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
} as const;

export type SignCertificateStatusEnum = (typeof SignCertificateStatusEnum)[keyof typeof SignCertificateStatusEnum];
