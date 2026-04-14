import type { CustomDataType } from '../common/CustomDataType.js';

export interface GetTransactionStatusRequest {
  transactionId?: string;
  customData?: CustomDataType;
}
