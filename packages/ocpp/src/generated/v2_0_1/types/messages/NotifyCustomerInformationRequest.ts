import type { CustomDataType } from '../common/CustomDataType.js';

export interface NotifyCustomerInformationRequest {
  customData?: CustomDataType;
  data: string;
  tbc?: boolean;
  seqNo: number;
  generatedAt: string;
  requestId: number;
}
