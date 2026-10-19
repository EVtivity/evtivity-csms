import type { CustomDataType } from '../common/CustomDataType.js';

export interface FirmwareType {
  customData?: CustomDataType;
  location: string;
  retrieveDateTime: string;
  installDateTime?: string;
  signingCertificate?: string;
  signature?: string;
}

export interface UpdateFirmwareRequest {
  customData?: CustomDataType;
  retries?: number;
  retryInterval?: number;
  requestId: number;
  firmware: FirmwareType;
}
