import type { CustomDataType } from '../common/CustomDataType.js';

export interface NotifyCustomerInformationRequest {
  data: string;
  tbc?: boolean;
  seqNo: number;
  generatedAt: string;
  requestId: number;
  customData?: CustomDataType;
}
