export const CertificateSigningUseEnum = {
  ChargingStationCertificate: 'ChargingStationCertificate',
  V2GCertificate: 'V2GCertificate',
  V2G20Certificate: 'V2G20Certificate',
} as const;

export type CertificateSigningUseEnum = (typeof CertificateSigningUseEnum)[keyof typeof CertificateSigningUseEnum];
