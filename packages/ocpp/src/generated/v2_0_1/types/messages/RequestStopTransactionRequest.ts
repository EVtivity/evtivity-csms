import type { CustomDataType } from '../common/CustomDataType.js';

export interface RequestStopTransactionRequest {
  customData?: CustomDataType;
  transactionId: string;
}
