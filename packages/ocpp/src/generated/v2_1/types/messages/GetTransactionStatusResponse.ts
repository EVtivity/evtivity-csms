import type { CustomDataType } from '../common/CustomDataType.js';

export interface GetTransactionStatusResponse {
  ongoingIndicator?: boolean;
  messagesInQueue: boolean;
  customData?: CustomDataType;
}
