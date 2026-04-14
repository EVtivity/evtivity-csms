import type { CustomDataType } from '../common/CustomDataType.js';

export interface DataTransferRequest {
  messageId?: string;
  data?: string;
  vendorId: string;
  customData?: CustomDataType;
}
