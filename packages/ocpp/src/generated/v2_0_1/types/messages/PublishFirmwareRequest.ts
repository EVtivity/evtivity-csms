import type { CustomDataType } from '../common/CustomDataType.js';

export interface PublishFirmwareRequest {
  customData?: CustomDataType;
  location: string;
  retries?: number;
  checksum: string;
  requestId: number;
  retryInterval?: number;
}
