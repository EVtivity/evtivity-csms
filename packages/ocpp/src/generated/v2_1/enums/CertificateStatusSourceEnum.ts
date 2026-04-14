export const CertificateStatusSourceEnum = {
  CRL: 'CRL',
  OCSP: 'OCSP',
} as const;

export type CertificateStatusSourceEnum = (typeof CertificateStatusSourceEnum)[keyof typeof CertificateStatusSourceEnum];
