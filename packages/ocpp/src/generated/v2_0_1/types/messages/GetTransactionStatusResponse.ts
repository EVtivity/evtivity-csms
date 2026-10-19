import type { CustomDataType } from '../common/CustomDataType.js';

export interface GetTransactionStatusResponse {
  customData?: CustomDataType;
  ongoingIndicator?: boolean;
  messagesInQueue: boolean;
}
