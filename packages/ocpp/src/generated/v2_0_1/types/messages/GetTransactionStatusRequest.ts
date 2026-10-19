import type { CustomDataType } from '../common/CustomDataType.js';

export interface GetTransactionStatusRequest {
  customData?: CustomDataType;
  transactionId?: string;
}
