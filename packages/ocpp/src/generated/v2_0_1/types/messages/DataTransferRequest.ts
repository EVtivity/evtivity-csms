import type { CustomDataType } from '../common/CustomDataType.js';

export interface DataTransferRequest {
  customData?: CustomDataType;
  messageId?: string;
  data?: string;
  vendorId: string;
}
