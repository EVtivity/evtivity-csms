export const CertificateActionEnum = {
  Install: 'Install',
  Update: 'Update',
} as const;

export type CertificateActionEnum = (typeof CertificateActionEnum)[keyof typeof CertificateActionEnum];
