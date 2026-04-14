import type { CustomDataType } from '../common/CustomDataType.js';

export interface RequestStopTransactionRequest {
  transactionId: string;
  customData?: CustomDataType;
}
