import type { CustomDataType } from '../common/CustomDataType.js';

export interface FirmwareType {
  location: string;
  retrieveDateTime: string;
  installDateTime?: string;
  signingCertificate?: string;
  signature?: string;
  customData?: CustomDataType;
}

export interface UpdateFirmwareRequest {
  retries?: number;
  retryInterval?: number;
  requestId: number;
  firmware: FirmwareType;
  customData?: CustomDataType;
}
