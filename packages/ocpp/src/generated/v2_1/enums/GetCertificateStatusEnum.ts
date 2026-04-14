export const GetCertificateStatusEnum = {
  Accepted: 'Accepted',
  Failed: 'Failed',
} as const;

export type GetCertificateStatusEnum = (typeof GetCertificateStatusEnum)[keyof typeof GetCertificateStatusEnum];
