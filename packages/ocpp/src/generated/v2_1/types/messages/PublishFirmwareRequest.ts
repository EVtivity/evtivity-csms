import type { CustomDataType } from '../common/CustomDataType.js';

export interface PublishFirmwareRequest {
  location: string;
  retries?: number;
  checksum: string;
  requestId: number;
  retryInterval?: number;
  customData?: CustomDataType;
}
