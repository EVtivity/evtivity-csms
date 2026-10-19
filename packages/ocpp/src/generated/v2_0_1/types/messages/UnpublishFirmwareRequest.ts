import type { CustomDataType } from '../common/CustomDataType.js';

export interface UnpublishFirmwareRequest {
  customData?: CustomDataType;
  checksum: string;
}
