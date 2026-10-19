export const Iso15118EVCertificateStatusEnum = {
  Accepted: 'Accepted',
  Failed: 'Failed',
} as const;

export type Iso15118EVCertificateStatusEnum = (typeof Iso15118EVCertificateStatusEnum)[keyof typeof Iso15118EVCertificateStatusEnum];
