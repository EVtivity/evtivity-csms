import type { CustomDataType } from '../common/CustomDataType.js';

export interface UnpublishFirmwareRequest {
  checksum: string;
  customData?: CustomDataType;
}
