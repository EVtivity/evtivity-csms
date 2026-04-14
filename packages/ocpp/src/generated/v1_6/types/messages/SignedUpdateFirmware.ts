export interface FirmwareType {
  location: string;
  retrieveDateTime: string;
  installDateTime?: string;
  signingCertificate: string;
  signature: string;
}

export interface SignedUpdateFirmware {
  requestId: number;
  retries?: number;
  retryInterval?: number;
  firmware: FirmwareType;
}
