export const CertificateSignedStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
} as const;

export type CertificateSignedStatusEnum = (typeof CertificateSignedStatusEnum)[keyof typeof CertificateSignedStatusEnum];
