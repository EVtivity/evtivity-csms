export const CertificateStatusEnum = {
  Good: 'Good',
  Revoked: 'Revoked',
  Unknown: 'Unknown',
  Failed: 'Failed',
} as const;

export type CertificateStatusEnum = (typeof CertificateStatusEnum)[keyof typeof CertificateStatusEnum];
